// @flow

import tingodb from 'tingodb';
import type {tcoll as Collection} from 'tingodb';
import fs from 'fs';
import Chunk, {emptyChunk} from './chunk.js';
import {invariant} from './assert.js';

const __tingodb = tingodb();

const Db = __tingodb.Db;
const Binary = __tingodb.Binary;

type ChunkStream = (cb: (chunk: Chunk) => void) => Promise<void>
type ChunkItem = {hash: string, data: Uint8Array};
type DbRecord = {hash: string, data: Binary};

declare class CursorStream {
  pause(): void;
  resume(): void;
  on(event: 'data', cb: (record: DbRecord) => void): void;
  on(event: 'end', cb: () => void): void;
}

type ChunkIndex = Map<string, number>;

export default class OrderedPutCache {
  _chunkIndex: ChunkIndex;
  _folder: string;
  _coll: Promise<DbCollection>;
  _appends: Set<Promise<void>>;

  constructor() {
    this._chunkIndex = new Map();
    this._folder = '';
    this._coll = this._init();
    this._appends = new Set();
  }

  _init(): Promise<DbCollection> {
    // invariant(false === true);
    return makeTempDir().then((dir): Promise<DbCollection> => {
      // console.log('creating', dir);
      this._folder = dir;
      const coll = new DbCollection(dir);
      return coll.ensureIndex({hash: 1}, {unique: true}).then(() => coll);
    });
  }

  append(c: Chunk): boolean {
    const hash = c.ref.toString();
    if (this._chunkIndex.has(hash)) {
      return false;
    }
    this._chunkIndex.set(hash, -1);
    const p = this._coll
      .then(coll => coll.insert({hash: hash, data: c.data}))
      .then(itemId => this._chunkIndex.set(hash, itemId))
      .then(() => { this._appends.delete(p); });
    this._appends.add(p);
    return true;
  }

  get(hash: string): ?Promise<Chunk> {
    if (!this._chunkIndex.has(hash)) {
      return null;
    }
    //$FlowIssue
    return Promise.all(this._appends)
      .then(() => this._coll)
      .then(coll => coll.findOne(hash))
      .then(item => {
        if (item) {
          return new Chunk(item.data);
        }
        return emptyChunk;
      });
  }

  dropUntil(limit: string): Promise<void> {
    if (!this._chunkIndex.has(limit)) {
      return Promise.reject(new Error('Tried to drop unknown chunk: ' + limit));
    }
    //$FlowIssue
    return Promise.all(this._appends).then(() => this._coll).then(coll => {
      let count = 0;
      for (const [hash, dbKey] of this._chunkIndex) {
        count++;
        this._chunkIndex.delete(hash);
        if (hash === limit) {
          return coll.dropUntil(dbKey).then(dropped => invariant(dropped === count));
        }
      }
    });
  }

  extractChunks(first: string, last: string): Promise<ChunkStream> {
    //$FlowIssue
    return Promise.all(this._appends)
      .then(() => this._coll)
      .then(coll => {
        const firstDbKey = this._chunkIndex.get(first);
        const lastDbKey = this._chunkIndex.get(last);
        if (firstDbKey === undefined) {
          throw new Error('Tried to range from unknown chunk: ' + first);
        }
        if (lastDbKey === undefined) {
          throw new Error('Tried to range to unknown chunk: ' + last);
        }
        return coll.findRange(firstDbKey, lastDbKey);
      });
  }

  destroy(): Promise<void> {
    return this._coll.then(() => removeDir(this._folder));
  }
}

function createChunkStream(stream: CursorStream): ChunkStream {
  return function(cb: (chunk: Chunk) => void): Promise<void> {
    return new Promise(fulfill => {
      stream.on('data', (record: DbRecord) => {
        const item = recordToItem(record);
        cb(new Chunk(item.data));
      });

      stream.resume();
      stream.on('end', fulfill);
    });
  };
}

class DbCollection {
  _coll: Collection;

  constructor(folder: string) {
    const db = new Db(folder, {});
    this._coll = db.collection('puts');
  }

  ensureIndex(obj: Object, options: Object = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      options.w = 1;
      this._coll.ensureIndex(obj, options, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  insert(item: ChunkItem, options: Object = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      options.w = 1;
      //$FlowIssue
      const data = new Binary(new Buffer(item.data.buffer));
      this._coll.insert({hash: item.hash, data: data}, options, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result[0]._id);
        }
      });
    });
  }

  findOne(hash: string, options: Object = {}): Promise<ChunkItem> {
    return new Promise((resolve, reject) => {
      options.w = 1;
      this._coll.findOne({hash: hash}, options, (err, record) => {
        if (err) {
          reject(err);
        } else {
          resolve(recordToItem(record));
        }
      });
    });
  }

  findRange(first: number, last: number, options: Object = {}): ChunkStream {
    options.w = 1;
    options.hint = {_id: 1};
    const stream = this._coll.find({_id: {$gte: first, $lte: last}}, options).stream();
    stream.pause();
    return createChunkStream(stream);
  }

  dropUntil(limit: number, options: Object = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      options.w = 1;
      this._coll.remove({_id: {$lte: limit}}, options, (err, numRemovedDocs) => {
        if (err) {
          reject(err);
        } else {
          resolve(numRemovedDocs);
        }
      });
    });
  }
}

function recordToItem(record: DbRecord): ChunkItem {
  return {hash: record.hash, data: new Uint8Array(record.data.buffer)};
}

function makeTempDir(): Promise<string> {
  return new Promise((resolve, reject) => {
    //$FlowIssue
    fs.mkdtemp('/tmp/put-cache-', (err, folder) => {
      if (err) {
        reject(err);
      } else {
        resolve(folder);
      }
    });
  });
}

async function removeDir(dir: string): Promise<void> {
  await access(dir);
  const files = await readdir(dir);
  for (const file of files) {
    await unlink(dir + '/' + file);
  }
  return rmdir(dir);
}

function access(path: string, mode = fs.F_OK): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.access(path, mode, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function readdir(path: string): Promise<Array<string>> {
  return new Promise((resolve, reject) => {
    fs.readdir(path, (err, files) => {
      if (err) {
        reject(err);
      } else {
        resolve(files);
      }
    });
  });
}

function rmdir(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.rmdir(path, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function unlink(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.unlink(path, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
