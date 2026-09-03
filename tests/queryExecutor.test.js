'use strict';

jest.mock('async-retry', () => {
    return async (fn) => fn();
});

const QueryExecutor = require('../src/utils/queryExecutor').default;

describe('QueryExecutor', () => {
    it('returns records from a successful REST query', async () => {
        const conn = {
            query: jest.fn().mockResolvedValue({
                done: true,
                records: [{ Id: '001', Name: 'Admin' }],
            }),
            bulk2: { query: jest.fn() },
        };
        const executor = new QueryExecutor(conn);
        const records = await executor.executeQuery('SELECT Id, Name FROM Profile', false);
        expect(records).toEqual([{ Id: '001', Name: 'Admin' }]);
        expect(conn.bulk2.query).not.toHaveBeenCalled();
    });

    it('falls back to bulk2.query on HTTP 431', async () => {
        const conn = {
            version: '62.0',
            query: jest.fn().mockRejectedValue(new Error('431 Request Header Fields Too Large')),
            bulk2: {
                query: jest.fn().mockResolvedValue(
                    (async function* () {
                        yield { Id: '00e1', Name: 'Admin' };
                    })()
                ),
            },
        };
        const executor = new QueryExecutor(conn);
        const records = await executor.executeQuery('SELECT Id, Name FROM Profile WHERE Name IN (\'Admin\')', false);
        expect(conn.bulk2.query).toHaveBeenCalledTimes(1);
        expect(records).toEqual([
            {
                attributes: {
                    type: 'Profile',
                    url: '/services/data/v62.0/sobjects/Profile/00e1',
                },
                Id: '00e1',
                Name: 'Admin',
            },
        ]);
    });

    it('falls back to bulk2.query when the message includes Request Header Fields Too Large', async () => {
        const conn = {
            version: '62.0',
            query: jest.fn().mockRejectedValue(new Error('Request Header Fields Too Large')),
            bulk2: {
                query: jest.fn().mockResolvedValue(
                    (async function* () {
                        yield { Id: '00e2' };
                    })()
                ),
            },
        };
        const executor = new QueryExecutor(conn);
        const records = await executor.executeQuery('SELECT Id FROM CustomObject', false);
        expect(records[0].attributes.type).toBe('CustomObject');
        expect(records[0].Id).toBe('00e2');
    });

    it('does not use bulk fallback for unrelated errors', async () => {
        const conn = {
            query: jest.fn().mockRejectedValue(new Error('INVALID_FIELD')),
            bulk2: { query: jest.fn() },
        };
        const executor = new QueryExecutor(conn);
        await expect(executor.executeQuery('SELECT Id FROM Profile', false)).rejects.toThrow('INVALID_FIELD');
        expect(conn.bulk2.query).not.toHaveBeenCalled();
    });
});
