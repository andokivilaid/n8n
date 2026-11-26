import type * as E2bSdk from 'e2b';

let e2bMod: typeof E2bSdk | undefined;

export function loadE2b(): typeof E2bSdk {
	if (!e2bMod) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		e2bMod = require('e2b') as typeof E2bSdk;
	}
	return e2bMod;
}
