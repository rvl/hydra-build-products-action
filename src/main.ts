// This github actions workflow queries evaluation and build product
// urls from Hydra.
// Adapted from cardano-wallet/scripts/travis-download-builds.js

import * as core from '@actions/core'
import * as cache from '@actions/cache';
import _ from 'lodash';

import {hydra, Result, Download, formatTimings, HydraEval, HydraBuilds, HydraParams} from './hydra'
import {getActionPayload} from './github';

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
  project?: string;
  jobset?: string;
  requiredJob?: string;
  badge: boolean;
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
  const str = (s: string) => s;
  const optstr = (s: string) => s ? s : undefined;
  const flag = (s: string) => !!s;

  const actionInputs = {
    hydra: {
      env: "HYDRA_URL",
      parse: addTraillingSlash
    },
    statusName: {
      env: "HYDRA_EVAL_STATUS_NAME",
      parse: str
    },
    jobs: {
      env: "HYDRA_JOBS",
      parse: (jobs: string) => jobs.split(/ /)
    },
    requiredJob: {
      env: "HYDRA_REQUIRED_JOB",
      parse: optstr
    },
    project: {
      env: "HYDRA_PROJECT",
      parse: optstr
    },
    jobset: {
      env: "HYDRA_JOBSET",
      parse: optstr
    },
    evaluation: {
      env: "HYDRA_EVAL_JSON",
      parse: json
    },
    builds: {
      env: "HYDRA_BUILDS_JSON",
      parse: json
    },
    badge: {
      env: "DO_BADGE",
      parse: flag
    },
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
    timings: json(formatTimings(res.timings)),
    badge: res.badge || "",
  };
}

//////////////////////////////////////////////////////////////////////
// Caching

const cacheDir = ".hydra-build-products-action";
const cachePaths = [ `${cacheDir}/*` ];

function makeCachekey(evalId: number): string {
 return `hydra-eval-id-${evalId}`;
}

async function saveCache(res: Result) {
  const key = res.evaluation ? makeCachekey(res.evaluation.id) : undefined;
  if (key) {
    writeCacheFiles(res);
    const cacheId = await cache.saveCache(cachePaths, key);
  };
}

async function restoreCache(evalId: number, params: HydraParams) {
  // Maybe use (actionContext: ActionContext, statuses: GitHubStatus[])
  const key = makeCachekey(evalId);
  const restoreKeys = [ 'hydra-eval-id-', /* 'hydra-eval-rev-' */ ];
  const cachekey = await cache.restoreCache(cachePaths, key, restoreKeys);
  readCacheFiles(params);
}

function writeCacheFiles(res: Result) {
  // TODO
}

function readCacheFiles(params: HydraParams) {
  // TODO
}

//////////////////////////////////////////////////////////////////////
// Main function

async function run(): Promise<void> {
  try {
    // debug is only shown if you set the secret `ACTIONS_RUNNER_DEBUG` to true
    core.debug("rvl/hydra-build-products-action")

    const params = getActionInputs();

    const actionContext = getActionPayload();
    console.debug("GitHub action context", actionContext);

    const downloads: Download[] = _.map(params.jobs, (name: string) => {
      return { job: name, buildProducts: null };
    });

    const res = await hydra({
      hydraURL: params.hydra,
      jobs: params.jobs,
      actionContext,
      downloads,
      statusName: params.statusName,
      requiredJob: params.requiredJob,
      project: params.project,
      jobset: params.jobset,
      badge: params.badge,
      previous: {
        status: actionContext.previousStatus,
        evaluation: params.evaluation,
        builds: params.builds,
      },
    }, restoreCache);

    setActionOutputs(res);
    saveCache(res);
  } catch (error) {
    core.setFailed(error.message)
  }
}

run();
