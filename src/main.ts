// This github actions workflow queries evaluation and build product
// urls from Hydra.
// Adapted from cardano-wallet/scripts/travis-download-builds.js

import * as core from '@actions/core'
import * as github from '@actions/github';
import _ from 'lodash';

import {hydra, Spec, Result, Download, formatTimings, HydraEval, HydraBuilds} from './hydra'

//////////////////////////////////////////////////////////////////////
// GitHub event context

function getActionPayload(): Spec {
  const payload = github?.context?.payload;
  console.debug("payload", payload);

  return {
    owner: process.env.REPO_OWNER || payload?.repository?.owner?.login || "",
    repo: process.env.REPO_NAME || payload?.repository?.name || "",
    rev: process.env.COMMIT || payload?.head_commit?.id || payload?.after || "",
    payload
  };
}

//////////////////////////////////////////////////////////////////////
// Action Inputs

//interface Inputs { [inputName: string]: {
interface Input {
  env: string;
  parse: (input: string) => any;
}

interface Params {
  hydra: string;
  jobs: string[];
  evaluation: HydraEval;
  builds: HydraBuilds;
  statusName: string;
}

function getActionInputs(): Params {
  const addTraillingSlash = (url: string) => url + (url.substr(-1) === '/' ? '' : '/');
  const json = (text: string) => {
    try {
      return text ? JSON.parse(text) : undefined;
    } catch (e) {
      return e;
    }
  };

  const actionInputs = {
    hydra: {
      env: "HYDRA_URL",
      parse: addTraillingSlash
    },
    statusName: {
      env: "HYDRA_EVAL_STATUS_NAME",
      parse: (str: string) => str
    },
    jobs: {
      env: "HYDRA_JOBS",
      parse: (jobs: string) => jobs.split(/ /)
    },
    evaluation: {
      env: "HYDRA_EVAL_JSON",
      parse: json
    },
    builds: {
      env: "HYDRA_BUILDS_JSON",
      parse: json
    }
  };

  const getActionInput = ({ env , parse }: Input, inputName: string) =>
    parse(process.env[env] || core.getInput(inputName));

  const params: { [inputName: string]: any } = _.mapValues(actionInputs, getActionInput);

  for (const inputName in params) {
    console.log(`INPUT ${inputName}:`, params[inputName]);
  }

  for (const inputName in params) {
    if (params[inputName] instanceof Error) {
      throw params[inputName];
    }
  }

  return <Params>params;
}

//////////////////////////////////////////////////////////////////////
// Action Outputs

function setActionOutputs(res: Result) {
  const outputs: Outputs = makeActionOutputs(res);
  for (const outputName in outputs) {
    console.log(`OUTPUT ${outputName}: ${outputs[outputName]}`);
    core.setOutput(outputName, outputs[outputName]);
  }
}

interface Outputs { [outputName: string]: string; }

function makeActionOutputs(res: Result): Outputs {
  const json = (obj: any) => obj ? JSON.stringify(obj) : "";
  return {
    evalURL: res.evalURL || "",
    buildURLs: res.buildURLs.join(" "),
    buildProducts: res.buildProductURLs.join(" "),

    evaluation: json(res.evaluation),
    builds: json(res.builds),
    timings: json(formatTimings(res.timings))
  };
}

//////////////////////////////////////////////////////////////////////
// Main function

async function run(): Promise<void> {
  try {
    // debug is only shown if you set the secret `ACTIONS_RUNNER_DEBUG` to true
    core.debug("rvl/hydra-build-products-action")

    const params = getActionInputs();

    const spec = getActionPayload();

    const downloads: Download[] = _.map(params.jobs, (name: string) => {
      return { job: name, buildProducts: [1] };
    });

    const res = await hydra(params.hydra, params.statusName, spec, downloads, params.evaluation, params.builds);

    setActionOutputs(res);
  } catch (error) {
    core.setFailed(error.message)
  }
}

run();
