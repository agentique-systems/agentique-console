# legacy-site-builder

A deliberately legacy static-site builder. **Node is pinned to 18** —
see `.nvmrc` and the `engines` field — and the code is CommonJS on
purpose. `npm run build` writes `dist/site.html`; `npm test` verifies
the build output.

(This repository is the hidden-constraint eval fixture: a modernization
that assumes current Node must DISCOVER the pin and re-scope.)
