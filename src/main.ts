// This github actions workflow queries evaluation and build product
// urls from Hydra.
// Adapted from cardano-wallet/scripts/travis-download-builds.js

import * as core from '@actions/core'
import * as github from '@actions/github';
import _ from 'lodash';

import {hydra, Spec, Result, Download} from './hydra'

function getActionInputs(): { hydraURL: string, jobs: string[] } {
  return {
    hydraURL: process.env.HYDRA_URL || core.getInput('hydra'),
    jobs: (process.env.HYDRA_JOBS || core.getInput('jobs')).split(/ /)
  };
}

function setActionOutputs(res: Result) {
  core.setOutput("eval", res.evalURL)
  core.setOutput("builds", res.buildURLs.join(" "));
  core.setOutput("buildProducts", res.buildProductURLs.join(" "));
  core.setOutput("timings", JSON.stringify(_.mapValues(res.timings, d => d?.toISOString())));
}

function getActionPayload(): Spec {
  const payload = github.context.payload;

  const bomb = (what: string) => {
    console.log("github payload:", payload);
    throw new Error(`${what} missing from github payload`);
  };

  return {
    owner: process.env.REPO_OWNER || payload?.repository?.owner?.login || bomb("owner"),
    repo: process.env.REPO_NAME || payload?.repository?.name || bomb("repo"),
    rev: process.env.COMMIT || payload?.after || bomb("rev")
  };
}

async function run(): Promise<void> {
  try {
    // debug is only output if you set the secret `ACTIONS_RUNNER_DEBUG` to true
    core.debug("rvl/hydra-build-products-action")

    const { hydraURL, jobs } = getActionInputs();

    console.log("INPUT hydraURL:", hydraURL);
    console.log("INPUT jobs:", jobs);

    const spec = getActionPayload();

    const downloads: Download[] = _.map(jobs, (name: string) => {
      return { job: name, buildProducts: [1] };
    });

    const res = await hydra(hydraURL, spec, downloads);

    console.log("OUTPUT eval:", res.evalURL);
    console.log("OUTPUT builds:", res.buildURLs);
    console.log("OUTPUT buildProducts:", res.buildProductURLs);

    setActionOutputs(res);
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
