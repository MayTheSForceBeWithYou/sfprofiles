'use strict';

const fs = require('fs');
const path = require('path');

describe('profileRetriever SOQL', () => {
    it('selects Id and Name when fetching profile permissions', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../src/impl/metadata/retriever/profileRetriever.ts'),
            'utf8'
        );
        expect(source).toContain('SELECT Id, Name, ${permissionStr} FROM Profile WHERE Name IN');
    });
});
