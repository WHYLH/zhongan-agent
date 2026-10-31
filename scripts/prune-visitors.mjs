import { DEFAULT_DB_PATH, ensureServiceTables, listVisitorProfiles, openDatabase, pruneVisitors, visitorStorageBytes } from '../db.mjs';

const limitMb = Math.max(0.05, Number(process.env.VISITOR_STORAGE_LIMIT_MB) || Number(process.argv[2]) || 100);
const db = openDatabase(process.env.FUND_DB_PATH || DEFAULT_DB_PATH);
ensureServiceTables(db);
const before = visitorStorageBytes(db);
const beforeCount = listVisitorProfiles(db).length;
const result = pruneVisitors(db, { limitBytes: limitMb * 1024 * 1024 });
const after = visitorStorageBytes(db);
const afterCount = listVisitorProfiles(db).length;
console.log(JSON.stringify({
  limitMb,
  beforeMb: Number((before / 1024 / 1024).toFixed(2)),
  afterMb: Number((after / 1024 / 1024).toFixed(2)),
  beforeCount,
  afterCount,
  removed: result.removed
}, null, 2));
db.close();