// Website entry: everything goes through this site's own server under /api.
import { boot } from '../app/boot.ts';
import { siteRuntime } from './runtime.ts';

boot(siteRuntime);
