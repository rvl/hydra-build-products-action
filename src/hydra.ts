// import fs from 'fs';
// import path from 'path';
// import * as github from '@actions/github';

import {AxiosRequestConfig, AxiosResponse, AxiosInstance} from 'axios';
import axios from 'axios';
import _ from 'lodash';

//////////////////////////////////////////////////////////////////////
// GitHub API Requests

function makeGitHubApi(options = {}): AxiosInstance {
  const api = axios.create(_.merge({
    baseURL: "https://api.github.com/",
    headers: { "Content-Type": "application/json" },
  }, options));
  api.interceptors.request.use((request: AxiosRequestConfig) => {
    console.debug(`${request.method} ${request.baseURL}${request.url}`);
    return request;
  });
  return api;
}

//////////////////////////////////////////////////////////////////////
// Hydra API Requests

function makeHydraApi(hydraURL: string, options = {}) {
  const api = axios.create(_.merge({
    baseURL: hydraURL,
    headers: { "Content-Type": "application/json" },
  }, options));
  api.interceptors.request.use(request => {
    console.debug("Hydra " + request.url);
    return request;
  });
  return api;
}

//////////////////////////////////////////////////////////////////////
// Hydra Types

interface HydraEval {
  id: number; // evaluation id
  builds: number[]; // a list of build ids
  jobsetevalinputs: { [name: string]: HydraJobsetEvalInput; };
  hasnewbuilds: number; // some flag
  errormsg?: string; // evaluation error, if any
}

interface HydraJobsetEvalInput {
  uri: string
  value: string;
  revision: string;
  type: string;
}

interface HydraJobsetEvals {
  evals: HydraEval[];
  next: string; // relative url for next page
  first: string; // relative url for first page
  last: string; // relative url for last page
}

interface HydraBuilds {
  [name: string]: HydraBuild;
}

export interface HydraBuild {
  id: number; // build id
  project: string;
  jobset: string;
  jobsetevals: number[]; // the evaluations this is part of
  job: string; // release.nix attribute name

  buildproducts: HydraBuildProducts;
  buildmetrics: {};

  // nix stuff
  nixname: string;
  buildoutputs: {};
  drvpath: string;

  // status
  buildstatus: number; // 0 is good
  finished: number; // 1 is good

  // timings
  starttime: number;
  stoptime: number;
  timestamp: number;
}

interface HydraBuildProducts {
  [id: string]: HydraBuildProduct;
}

export interface HydraBuildProduct {
  name: string;
  type: string;
  path: string;
}

function findEvalByInput(evals: HydraEval[], spec: Spec) {
  return _.find(evals, e => e.jobsetevalinputs[spec.repo] && e.jobsetevalinputs[spec.repo].revision === spec.rev);
}

async function findEvalByCommit(api: AxiosInstance, project: string, jobset: string, spec: Spec, page?: string): Promise<null|HydraEval> {
  const evalsPath = `jobset/${project}/${jobset}/evals${page || ""}`;
  const response: AxiosResponse<HydraJobsetEvals> = await api.get(evalsPath);

  const evaluation = findEvalByInput(response.data.evals, spec);

  if (evaluation) {
    return evaluation;
  } else if (response.data.next) {
    return findEvalByCommit(api, project, jobset, spec, response.data.next);
  } else {
    return null;
  }
}

async function findCardanoWalletEval(api: AxiosInstance, rev: string): Promise<null|HydraEval> {
  const spec = { owner: "input-output-hk", repo: "cardano-wallet", rev };
  return findEvalByCommit(api, "Cardano", "cardano-wallet", spec);
}

function sleep(ms = 0): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
};

interface GitHubStatus {
  context: string;
  state: string
  target_url: string;
}

async function findEvalsFromGitHub(hydraApi: AxiosInstance, githubApi: AxiosInstance, spec: Spec, page?: number): Promise<HydraEval[]> {
  const q = "?per_page=100" + (page ? `&page=${page}` : "");
  const {owner, repo, rev} = spec;
  const response: AxiosResponse<GitHubStatus[]> = await githubApi.get(`repos/${owner}/${repo}/commits/${rev}/statuses${q}`);

  const retry = async () => {
    console.log(`Eval not found, and no more pages from GitHub.`);
    console.log(`Waiting for updated CI status.`);
    await sleep(60000);
    return await findEvalsFromGitHub(hydraApi, githubApi, spec);
  }

  if (_.isEmpty(response.data)) {
    return await retry();
  }

  const statuses = _.filter(response.data, status => status.context.startsWith("ci/hydra-eval"));
  const successful = _.filter(statuses, { state: "success" });
  const pending = _.filter(statuses, { state: "pending" });
  const failed = _.difference(statuses, successful, pending);

  console.log("statuses", JSON.stringify(statuses));

  console.log(`Found ${statuses.length} eval statuses:  successful=${successful.length}  pending=${pending.length}  failed=${failed.length}`);

  let evals = [];
  for await (const status of successful) {
    const evaluation = await hydraApi.get(status.target_url);
    if (!_.isEmpty(evaluation.data)) {
      evals.push(evaluation.data);
    }
  }

  if (_.isEmpty(evals)) {
    if (pending.length) {
      console.log("Eval is pending - trying again...");
      return await waitForPendingEval(hydraApi, spec, pending);
    } else if (failed.length) {
      const msg = "Can't get eval - it was not successful.";
      console.error(msg);
      throw new Error(msg);
    } else if (response.headers["Link"]) {
      const next = (page || 1) + 1;
      console.log(`Eval not found - trying page ${next}`);
      return await findEvalsFromGitHub(hydraApi, githubApi, spec, next);
    } else {
      console.log(`Eval not found`);
      return await retry();
    }
  } else {
    return evals;
  }
}

async function waitForPendingEval(hydraApi: AxiosInstance, spec: Spec, pendings: GitHubStatus[]): Promise<HydraEval[]> {

  await sleep(10000);

  let evals: HydraEval[] = [];
  for await (const pending of pendings) {
    const jobset: AxiosResponse<HydraEval> = await hydraApi.get(pending.target_url);
    if (jobset.data.errormsg) {
      console.log(`There is a currently an evaluation error for jobset: ${pending.target_url}`);
    }

    const evalsURL = pending.target_url.replace(/#.*$/, "/evals");
    const jobsetEvals = await hydraApi.get(evalsURL);
    console.log(JSON.stringify(jobsetEvals.data));
    console.log(`There are ${jobsetEvals.data.evals.length} eval(s)`);
    const evaluation = findEvalByInput(jobsetEvals.data.evals, spec);
    if (evaluation) {
      console.log("Found eval", evaluation);
      evals.push(evaluation);
    }
  }

  if (_.isEmpty(evals)) {
    console.log("Eval is still pending - trying again...");
    return waitForPendingEval(hydraApi, spec, pendings);
  } else {
    return evals;
  }
}

async function findBuildsInEvals(hydraApi: AxiosInstance, evals: HydraEval[], jobs: string[]): Promise<HydraBuilds> {
  let builds: HydraBuilds = {};
  for (const evaluation of evals) {
    for (const build of evaluation.builds) {
      const response: AxiosResponse<HydraBuild> = await hydraApi.get(`build/${build}`);
      if (_.includes(jobs, response.data.job)) {
        console.log(`Found ${response.data.job}`);
        builds[response.data.job] = response.data;
        if (_.size(builds) === _.size(jobs)) {
          break;
        }
      }
    }
  }
  return builds;
}

function buildProductDownloadURL(hydraURL: string, build: HydraBuild, num: string) {
  const buildProduct = build.buildproducts[num];
  const filename = buildProduct.name;
  return `${hydraURL}build/${build.id}/download/${num}/${filename}`;
}

//////////////////////////////////////////////////////////////////////
// Main action

export interface Spec {
  owner: string,
  repo: string,
  rev: string
}

export interface Download {
  job: string;
  buildProducts: number[];
}

export interface Result {
  evalIDs: number[];
  evalURLs: string[];
  buildURLs: string[];
  buildProducts: string[];
  builds: HydraBuilds;
  evals: HydraEval[];
}

export async function hydra(hydraURL: string, spec: Spec, downloads: Download[], options = {}): Promise<Result> {
  const hydraApi = makeHydraApi(hydraURL, options);
  const githubApi = makeGitHubApi(options);

  const evals = await findEvalsFromGitHub(hydraApi, githubApi, spec);
  console.log(`${evals.length} eval(s) has ${_.sumBy(evals, e => e.builds.length)} builds`);

  const builds = await findBuildsInEvals(hydraApi, evals, _.map(downloads, d => d.job));

  // todo: poll the builds

  let urls = [];

  if (_.isEmpty(builds)) {
    console.log("Didn't find any builds in evals.");
  } else {
    for (let i = 0; i < downloads.length; i++) {
      const build = builds[downloads[i].job];
      for (let j = 0; j < downloads[i].buildProducts.length; j++) {
        urls.push(buildProductDownloadURL(hydraURL, build, "" + downloads[i].buildProducts[j]));
      }
    }
  }

  return {
    evalIDs: _.map(evals, "id"),
    evalURLs: _.map(evals, evaluation => `${hydraURL}eval/${evaluation.id}`),
    buildURLs: _.map(builds, build => `${hydraURL}build/${build.id}`),
    buildProducts: urls,
    builds: builds,
    evals: evals
  };
}
