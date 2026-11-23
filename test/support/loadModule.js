// Test loader.
//
// The production code is plain CommonJS. Tests load it through node:vm with
// stubbed '@azure/functions', '@azure/identity' and 'mssql' modules, so no
// Azure account, Functions runtime or database is needed.
//
// The loader compiles one module at a time and follows relative requires by
// hand, injecting the same stubs into every module in the graph. Module-level
// state (the cached token, the registered route) is per-load, so each test gets
// a clean slate.

const { readFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { compileFunction } = require('node:vm');

// processStub stands in for the Node process global. Tests pass { env: {} },
// which gives the module under test an empty environment to read from.
function createLoader(entryPath, stubs, processStub = { env: {} }) {
    const cache = new Map();
    const fakeProcess = { ...processStub, env: { ...(processStub.env ?? {}) } };

    function load(filePath) {
        const resolved = require.resolve(filePath);

        if (cache.has(resolved)) {
            return cache.get(resolved).exports;
        }

        const source = readFileSync(resolved, 'utf8');
        const module = { exports: {} };
        cache.set(resolved, module);

        const localRequire = (request) => {
            if (Object.prototype.hasOwnProperty.call(stubs, request)) {
                return stubs[request];
            }

            if (request.startsWith('.')) {
                return load(resolve(dirname(resolved), request));
            }

            return require(request);
        };

        const compiled = compileFunction(
            source,
            ['require', 'module', 'exports', 'process', '__filename', '__dirname'],
            { filename: resolved }
        );

        compiled(localRequire, module, module.exports, fakeProcess, resolved, dirname(resolved));

        return module.exports;
    }

    // Returns the entry module's exports plus a get() so a test can reach any
    // other module in the same graph, sharing one stub set and one cache.
    return {
        entry: load(entryPath),
        get: (filePath) => load(filePath)
    };
}

module.exports = {
    createLoader
};
