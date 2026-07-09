/*!
 * I'm Queue Software Project
 * Copyright (C) 2026  imqueue.com <support@imqueue.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * If you want to use this code in a closed source (commercial) project, you can
 * purchase a proprietary commercial license. Please contact us at
 * <support@imqueue.com> to get commercial licensing options.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { RedisCache } from '@imqueue/rpc';
import { REDIS_INIT_ERROR, TagCache } from '../index.js';

/**
 * Minimal in-memory stand-in for the ioredis client surface TagCache uses:
 * get/mget, multi (set/sadd/pexpire/del/srem + exec), smembers and scan.
 */
function fakeRedis() {
    const strings = new Map<string, string>();
    const sets = new Map<string, Set<string>>();

    const applyOp = ([cmd, ...args]: any[]): void => {
        switch (cmd) {
            case 'set':
                strings.set(args[0], args[1]);
                break;
            case 'sadd': {
                const set = sets.get(args[0]) || new Set<string>();
                set.add(args[1]);
                sets.set(args[0], set);
                break;
            }
            case 'del':
                for (const key of args) {
                    strings.delete(key);
                    sets.delete(key);
                }
                break;
            case 'srem': {
                const set = sets.get(args[0]);
                for (const member of args.slice(1)) {
                    set?.delete(member);
                }
                break;
            }
            case 'pexpire':
                break;
            default:
                throw new Error(`unexpected command: ${cmd}`);
        }
    };

    return {
        strings,
        sets,
        async get(key: string) {
            return strings.get(key) ?? null;
        },
        async mget(keys: string[]) {
            return keys.map(key => strings.get(key) ?? null);
        },
        multi() {
            const ops: any[][] = [];
            const chain: any = new Proxy(
                {},
                {
                    get: (_, cmd: string) => {
                        if (cmd === 'exec') {
                            return async () => ops.forEach(applyOp);
                        }
                        return (...args: any[]) => {
                            ops.push([cmd, ...args]);
                            return chain;
                        };
                    },
                },
            );
            return chain;
        },
        smembers(key: string, cb: (err: any, reply: string[]) => void) {
            cb(null, [...(sets.get(key) || [])]);
        },
        async scan() {
            return ['0', [...sets.keys()]];
        },
    };
}

function makeCache(redis?: any): TagCache {
    (RedisCache as any).redis = redis;

    return new TagCache({
        logger: console,
        key: (key: string) => `ns:${key}`,
    } as any);
}

describe('TagCache', () => {
    let redis: ReturnType<typeof fakeRedis>;
    let cache: TagCache;

    beforeEach(() => {
        redis = fakeRedis();
        cache = makeCache(redis);
    });

    it('should be a class', () => {
        assert.equal(typeof TagCache, 'function');
    });

    describe('constructor()', () => {
        it('should pick up redis client and key factory from cache', () => {
            assert.equal(cache.redis, redis as any);
            assert.equal(cache.key('x'), 'ns:x');
        });
    });

    describe('get()', () => {
        it('should throw if redis is not initialized', async () => {
            const uninitialized = makeCache(undefined);

            await assert.rejects(() => uninitialized.get('key'), {
                message: REDIS_INIT_ERROR,
            });
        });

        it('should return null for a missing key', async () => {
            assert.equal(await cache.get('missing'), null);
        });

        it('should return a single value for a single key', async () => {
            await cache.set('one', { a: 1 }, ['tag']);

            assert.deepEqual(await cache.get('one'), { a: 1 });
        });

        it('should return an array of values for multiple keys', async () => {
            await cache.set('one', 1, ['tag']);
            await cache.set('two', 2, ['tag']);

            assert.deepEqual(await cache.get('one', 'two', 'nope'), [
                1,
                2,
                null,
            ]);
        });

        it('should not throw, but return null on redis errors', async () => {
            (redis as any).get = async () => {
                throw new Error('boom');
            };
            const warnings: any[] = [];
            cache.logger = {
                ...console,
                warn: (...a: any[]) => {
                    warnings.push(a);
                },
            } as any;

            assert.equal(await cache.get('key'), null);
            assert.equal(warnings.length, 1);
        });
    });

    describe('set()', () => {
        it('should throw if redis is not initialized', async () => {
            const uninitialized = makeCache(undefined);

            await assert.rejects(() => uninitialized.set('key', 1, []), {
                message: REDIS_INIT_ERROR,
            });
        });

        it('should store value and tag membership', async () => {
            assert.equal(await cache.set('one', { a: 1 }, ['t1', 't2']), true);
            assert.ok(redis.strings.has('ns:one'));
            assert.ok(redis.sets.get('ns:tag:t1')?.has('ns:one'));
            assert.ok(redis.sets.get('ns:tag:t2')?.has('ns:one'));
        });

        it('should accept ttl option', async () => {
            assert.equal(await cache.set('one', 1, ['t1'], 5000), true);
            assert.ok(redis.strings.has('ns:one'));
        });

        it('should not throw, but return false on redis errors', async () => {
            (redis as any).multi = () => {
                throw new Error('boom');
            };
            cache.logger = { ...console, warn: () => undefined } as any;

            assert.equal(await cache.set('key', 1, []), false);
        });
    });

    describe('invalidate()', () => {
        it('should throw if redis is not initialized', async () => {
            const uninitialized = makeCache(undefined);

            await assert.rejects(() => uninitialized.invalidate('tag'), {
                message: REDIS_INIT_ERROR,
            });
        });

        it('should remove keys tagged with given tags', async () => {
            await cache.set('one', 1, ['t1']);
            await cache.set('two', 2, ['t1']);
            await cache.set('three', 3, ['other']);

            assert.equal(await cache.invalidate('t1'), true);

            assert.equal(await cache.get('one'), null);
            assert.equal(await cache.get('two'), null);
            assert.equal(await cache.get('three'), 3);
        });

        it('should succeed when no keys match given tags', async () => {
            assert.equal(await cache.invalidate('unknown'), true);
        });

        it('should not throw, but return false on redis errors', async () => {
            await cache.set('one', 1, ['t1']);
            (redis as any).smembers = () => {
                throw new Error('boom');
            };
            cache.logger = { ...console, warn: () => undefined } as any;

            assert.equal(await cache.invalidate('t1'), false);
        });
    });
});
