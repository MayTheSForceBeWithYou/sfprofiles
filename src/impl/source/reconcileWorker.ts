import { Connection, Org, SfProject } from '@salesforce/core';
import { Sfpowerkit } from '@utils/sfpowerkit';
import SFPLogger, {LoggerLevel } from '@n8codes/sfp-logger';
import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as xml2js from 'xml2js';
import * as util from 'util';
import ProfileWriter from '@impl/metadata/writer/profileWriter';
import Profile from '@impl/metadata/schema';

import ProfileComponentReconciler from './profileComponentReconciler';
import { MetadataResolver, SourceComponent } from '@salesforce/source-deploy-retrieve';
import { ProfileSourceFile } from './profileActions';
import _ from 'lodash';

export default class ReconcileWorker {
    conn: Connection;
    public constructor(
        private targetOrg: string,
        private isSourceOnly: boolean,
        private srcFolders: string[]
    ) {}

    public async reconcile(profilesToReconcile: ProfileSourceFile[], destFolder: string) {
        //Init Cache for each worker thread from file system

        Sfpowerkit.initCache();

        if (this.targetOrg) {
            const org = await Org.create({ aliasOrUsername: this.targetOrg });
            this.conn = org.getConnection();
        }

        // Load the local components into the cache regardless of whether an org is connected.
        // Every reconcile step asks isComponentExistsInProjectDirectoryOrInOrg, so a component
        // that is about to be deployed from this source must count as existing: otherwise a
        // profile is stripped of permissions on the very metadata it ships alongside, and the
        // caller has to reconcile and deploy a second time once the org has caught up.
        await this.loadAllLocalComponents();

        let result: string[] = [];
        for (let count = 0; count < profilesToReconcile.length; count++) {
            let reconciledProfile = await this.reconcileProfileJob(profilesToReconcile[count], destFolder);
            result.push(reconciledProfile[0]);
        }
        return result;
    }

    private async loadAllLocalComponents() {
        const resolver = new MetadataResolver();

        for (const packageDirectory of await this.resolvePackageDirectories()) {
            try {
                const components = resolver.getComponentsFromPath(packageDirectory);
                for (const component of components) {
                    this.loadComponentsTocache(component);
                }
            } catch (error) {
                // A directory that holds no resolvable metadata is not an error here, it just
                // contributes nothing to the cache. Reconcile then falls back to the org.
                SFPLogger.log(
                    `Unable to load local components from ${packageDirectory}: ${error.message}`,
                    LoggerLevel.DEBUG
                );
            }
        }
    }

    /**
     * The absolute package directories to scan for local components.
     *
     * srcFolders reaches us as either a project root (sfp reconciles an unpacked artifact) or a
     * package directory (`sfp profile:reconcile --folder force-app`), so each entry is expanded
     * through its own sfdx-project.json when it has one and taken as-is when it does not. The
     * paths must be absolute: this runs on a worker thread whose cwd is the caller's, not the
     * folder being reconciled.
     */
    private async resolvePackageDirectories(): Promise<string[]> {
        const roots = this.srcFolders?.length > 0 ? this.srcFolders : [process.cwd()];
        const packageDirectories: string[] = [];

        for (const root of roots) {
            const absoluteRoot = path.resolve(root);
            if (fs.existsSync(path.join(absoluteRoot, 'sfdx-project.json'))) {
                const project = await SfProject.resolve(absoluteRoot);
                for (const packageDirectory of project.getPackageDirectories()) {
                    packageDirectories.push(packageDirectory.fullPath);
                }
            } else {
                packageDirectories.push(absoluteRoot);
            }
        }

        return packageDirectories;
    }

    private loadComponentsTocache(component:SourceComponent){
        Sfpowerkit.addToCache(`SOURCE_${component.type.name}_${component.fullName}`, true);
        Sfpowerkit.addToCache(`${component.type.name}_SOURCE_CACHE_AVAILABLE`, true);
        let children:SourceComponent[] = component.getChildren();
        for (const child of children) {
            this.loadComponentsTocache(child);
        }
    }

    public reconcileProfileJob(profileComponent: ProfileSourceFile, destFolder: string): Promise<string[]> {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        let reconcilePromise = new Promise<string[]>((resolve, reject) => {
            let result: string[] = []; // Handle result of command execution

            let profileXmlString = fs.readFileSync(profileComponent.path);
            const parser = new xml2js.Parser({ explicitArray: true });
            const parseString = util.promisify(parser.parseString) as _.Function1<xml2js.convertableToString, Promise<{ Profile: Profile }>>;
            parseString(profileXmlString)
                .then((parseResult) => {
                    let profileWriter = new ProfileWriter();
                    const profileObj: Profile = profileWriter.toProfile(parseResult.Profile); // as Profile
                    return profileObj;
                })
                .then((profileObj) => {
                    return new ProfileComponentReconciler(this.conn, this.isSourceOnly).reconcileProfileComponents(
                        profileObj,
                        profileComponent.name
                    );
                })
                .then((profileObj) => {
                    //write profile back
                    let outputFile = profileComponent.path;
                    if (destFolder != null) {
                        outputFile = path.join(destFolder, path.basename(profileComponent.path));
                    }
                    let profileWriter = new ProfileWriter();
                    profileWriter.writeProfile(profileObj, outputFile);
                    result.push(outputFile);
                    resolve(result);
                    return result;
                })
                .catch((error) => {
                    SFPLogger.log(
                        `Error while processing file ${profileComponent.path}.\n${error}`,
                        LoggerLevel.ERROR
                    );
                });
        });
        return reconcilePromise;
    }
}

Sfpowerkit.setLogLevel(workerData.loglevel, workerData.isJsonFormatEnabled);

let reconcileWorker = new ReconcileWorker(workerData.targetOrg, workerData.isSourceOnly, workerData.srcFolders);
reconcileWorker.reconcile(workerData.profileChunk, workerData.destFolder).then((result) => {
    parentPort.postMessage(result);
})
