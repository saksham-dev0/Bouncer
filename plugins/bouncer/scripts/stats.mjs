#!/usr/bin/env node
import { readLog } from '../lib/log.mjs';
import { summarize, renderStats } from '../lib/stats.mjs';

console.log(renderStats(summarize(readLog(), Date.now() - 7 * 24 * 3600e3)));
