# Download build products from Hydra CI

This GitHub action waits for the Hydra build of the current commit to
evaluate and build, then provides download URLs of the given build
products.

## How to use

```yaml
jobs:
  example:
    steps:
      - name: 'Wait for Hydra build'
        uses: rvl/hydra-build-products-action@master
        id: hydra
        with:
          hydra: https://hydra.iohk.io
          jobs: my-jobname
      - name: 'Use the Hydra Build'
        run: |
          echo "The build product URL is:"
          echo "${{ steps.hydra.outputs.buildProducts }}"
```

## Example

We use it in [`cardano-wallet/.github/workflows/windows.yml`](https://github.com/input-output-hk/cardano-wallet/blob/master/.github/workflows/windows.yml).

## Inputs

### `hydra : URL` - The Hydra instance

Sets the URL of your Hydra instance. Defaults to https://hydra.iohk.io/.

### `statusName : String` - GitHub CI status

The name of the GitHub CI status posted by Hydra when evaluation
finishes. This action will poll the given status to get an evaluation
URL. Defaults to `"ci/hydra-eval"`.

### `jobs : [String]` - (Optional) Required job names

An optional space-separate list of job names to get information for.

If empty, this action will just wait for evaluation to succeed.

### `evaluation : JSON` - (Optional) Previous result of hydra-build-products-action

It's possible to call this action multiple times, re-using and
updating the working state each time. When doing so, pass in the
`evaluation` output of the previous action as the `evaluation` input.

This input is a JSON string, in exactly the same format as the corresponding output.

### `builds : JSON` - (Optional) Previous result of hydra-build-products-action

## Outputs

### `evalURL : URL`

Link to evaluation page on Hydra.

### `buildURLs : [URL]`

Space-separated list of build URLs corresponding to the `jobs` input.

### `buildProducts : [URL]`

Space-separated list of build product download URLs from the builds of
all `jobs`.

### `evaluation : JSON`

Hydra evaluation object. Basically the same as what the Hydra API
returns.

### `builds : JSON`

Hydra builds object, mapping job name to build info. The build info is
basically the same as what the Hydra API returns.

### `timings : JSON`

Object with build time observations. Each value is a javascript `Date`
object.

| **Property**    | **Is the time when...**                                |
| ---             | ---                                                    |
| actionStarted   | the hydra-build-products-action step starts            |
| ciStatusCreated | the first GitHub CI status was created by Hydra and found by this action |
| evaluated       | this script finds that evaluation was successful       |
| foundBuilds     | when all builds for the input `jobs` were found        |
| built           | when all builds for the input `jobs` were found to be complete |

## Development information

Here are some notes, if you're like me and don't know much about
GitHub actions, or how to build Typescript things.

The most important thing is to remember to do this after making a
change:

```
npm run package && git commit -am "Rebuild dist/index.js"
```

### Run the tests

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

Run the tests
```bash
$ npm test

 PASS  ./index.test.js
  ✓ throws invalid number (3ms)
  ✓ wait 500 ms (504ms)
  ✓ test runs (95ms)

...
```

### Change the Code

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

### Publish to a distribution branch

Actions are run from GitHub repos so we will checkin the packed dist folder.

Build, package and push the results:
```bash
$ npm run package
$ git add dist
$ git commit -a -m "prod dependencies"
$ git push origin releases/v1
```


### Docs about actions

If you are new, there's also a simpler introduction.  See the [Hello World JavaScript Action](https://github.com/actions/hello-world-javascript-action)

See the [documentation](https://help.github.com/en/articles/metadata-syntax-for-github-actions)

See the [toolkit documentation](https://github.com/actions/toolkit/blob/master/README.md#packages) for the various packages.

See the [versioning documentation](https://github.com/actions/toolkit/blob/master/docs/action-versioning.md)

After testing you can [create a v1 tag](https://github.com/actions/toolkit/blob/master/docs/action-versioning.md) to reference the stable and latest V1 action

## CI

<a href="https://github.com/rvl/hydra-build-products-action/actions"><img alt="typescript-action status" src="https://github.com/rvl/hydra-build-products-action/workflows/build-test/badge.svg"></a>
