<p align="center">
  <a href="https://github.com/rvl/hydra-build-products-action/actions"><img alt="typescript-action status" src="https://github.com/rvl/hydra-build-products-action/workflows/build-test/badge.svg"></a>
</p>




## Run the tests

Install the dependencies
```bash
$ npm install
```

Build the typescript and package it for distribution
```bash
$ npm run build
```

Run [ncc](https://github.com/zeit/ncc) to produce `dist/index.js`.
```bash
npm run package
```

Run the tests :heavy_check_mark:
```bash
$ npm test

 PASS  ./index.test.js
  ✓ throws invalid number (3ms)
  ✓ wait 500 ms (504ms)
  ✓ test runs (95ms)

...
```

## Change the Code

Most toolkit and CI/CD operations involve async operations so the action is run in an async function.

```javascript
import * as core from '@actions/core';
...

async function run() {
  try {
      ...
  }
  catch (error) {
    core.setFailed(error.message);
  }
}

run()
```


## Publish to a distribution branch

Actions are run from GitHub repos so we will checkin the packed dist folder.

Build, package and push the results:
```bash
$ npm run package
$ git add dist
$ git commit -a -m "prod dependencies"
$ git push origin releases/v1
```


## Docs about actions

If you are new, there's also a simpler introduction.  See the [Hello World JavaScript Action](https://github.com/actions/hello-world-javascript-action)

See the [documentation](https://help.github.com/en/articles/metadata-syntax-for-github-actions)

See the [toolkit documentation](https://github.com/actions/toolkit/blob/master/README.md#packages) for the various packages.

See the [versioning documentation](https://github.com/actions/toolkit/blob/master/docs/action-versioning.md)

After testing you can [create a v1 tag](https://github.com/actions/toolkit/blob/master/docs/action-versioning.md) to reference the stable and latest V1 action
