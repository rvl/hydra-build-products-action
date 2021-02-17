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

async function findEvalFromGitHubStatus(hydraApi: AxiosInstance, githubApi: AxiosInstance, spec: Spec, onPending: () => void, page?: number): Promise<null|HydraEval> {
  const q = "?per_page=100" + (page ? `&page=${page}` : "");
  const {owner, repo, rev} = spec;
  const response: AxiosResponse<GitHubStatus[]> = await githubApi.get(`repos/${owner}/${repo}/commits/${rev}/statuses${q}`);

  const statusName = "ci/hydra-eval";
  const statuses = _(response.data).filter(status => status.context.startsWith(statusName)).sortBy("updated_at").reverse();

  //console.log("statuses", JSON.stringify(statuses.value()));

  if (!statuses.isEmpty()) {
    onPending();
  }

  const successful = statuses.filter({ state: "success" });
  const pending = statuses.filter({ state: "pending" });
  const failed = statuses.difference(successful.value(), pending.value());

  console.log(`Found ${statuses.size()} eval statuses matching ${statusName}:  successful=${successful.size()}  pending=${pending.size()}  failed=${failed.size()}`);

  // We can't simply take the latest succes status, because there are
  // sometimes "ghost" evaluations with no builds.
  const getGoodEval = async (statuses: GitHubStatus[]) => {
    const isGoodEval = async (status: GitHubStatus) => {
      const response: AxiosResponse<HydraEval> = await hydraApi.get(status.target_url);
      return _.isEmpty(response.data?.builds) ? null : response.data;
    };

    for await (const status of statuses) {
      const evaluation = await isGoodEval(status);
      if (evaluation) {
        return evaluation;
      } else {
        console.log("Discarding ghost eval status", status);
      }
    }
  };

  const evaluation = await getGoodEval(successful.value());

  const retry = (page?: number) => findEvalFromGitHubStatus(hydraApi, githubApi, spec, onPending, page);

  if (evaluation) {
    console.log(`Eval ${evaluation.id} is successful and has ${evaluation.builds.length} builds`);
    return evaluation;
  } else if (statuses.isEmpty()) {
    if (response.headers["Link"]) {
      const next = (page || 1) + 1;
      console.log(`Eval not found - trying page ${next}`);
      return await retry(next);
    } else {
      console.log(`Eval not found, and no more pages from GitHub - trying again from first page...`);
    }
  } else {
    if (!successful.isEmpty()) {
      console.log("Need a real successful eval - trying again...");
    } else if (!pending.isEmpty()) {
      console.log("Eval is pending - trying again...");
    } else {
      console.log("Eval is currently failed - trying again...");
    }
  }

  console.log(`Waiting a minute for updated CI status.`);
  await sleep(60000);
  return await retry();
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

// todo: unused
// async function findBuildsInEvals(hydraApi: AxiosInstance, evals: HydraEval[], jobs: string[]): Promise<HydraBuilds> {
//   let builds: HydraBuilds = {};
//   for (const evaluation of evals) {
//     builds.assign(await findBuildsInEval(evaluation));
//   }
//   return builds;
// }

function fetchHydraBuild(hydraApi: AxiosInstance, buildId: number): Promise<AxiosResponse<HydraBuild>> {
  return hydraApi.get(hydraBuildPath(buildId));
}

async function findBuildsInEval(hydraApi: AxiosInstance, evaluation: HydraEval, jobs: string[]): Promise<HydraBuilds> {
  let builds: HydraBuilds = {};
  for (const buildId of evaluation.builds) {
    const response: AxiosResponse<HydraBuild> = await fetchHydraBuild(hydraApi, buildId);
    const build = response.data
    if (_.includes(jobs, build.job)) {
      console.log(`Found job ${build.job}`);
      builds[build.job] = build
      if (_.size(builds) === _.size(jobs)) {
        console.log(`All jobs found`);
        break;
      }
    }
  }
  return builds;
}

function hydraBuildPath(buildId: number): string {
  return `build/${buildId}`;
}

function hydraBuildURL(hydraApi: AxiosInstance, buildId: number) {
  const hydraURL = <string>hydraApi.defaults.baseURL;
  return `${hydraURL}${hydraBuildPath(buildId)}`;
}

function hydraBuildProductDownloadURL(hydraApi: AxiosInstance, build: HydraBuild, num: string) {
  const buildProduct = build.buildproducts[num];
  const filename = buildProduct.name;
  return `${hydraBuildURL(hydraApi, build.id)}/download/${num}/${filename}`;
}

function fullJobName(build: HydraBuild): string {
  return `${build.project}:${build.jobset}:${build.job}`;
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
  evaluation?: HydraEval;
  evalURL?: string;
  builds: HydraBuilds;
  buildURLs: string[];
  buildProductURLs: string[];
  timings: Timings;
}

export interface Timings {
  actionStarted: Date;
  ciStatusCreated?: Date;
  evaluated?: Date;
  built?: Date;
}

export async function hydra(hydraURL: string, spec: Spec, downloads: Download[], options = {}): Promise<Result> {
  const timings: Timings = { actionStarted: new Date() };
  const onPending = () => {
    timings.ciStatusCreated = timings.ciStatusCreated || new Date();
  };

  const hydraApi = makeHydraApi(hydraURL, options);
  const githubApi = makeGitHubApi(options);

  const evaluation = await findEvalFromGitHubStatus(hydraApi, githubApi, spec, onPending);
  if (!evaluation) {
    const msg = "Couldn't get eval from GitHub status API.";
    console.error(msg);
    throw new Error(msg);
  }

  timings.evaluated = new Date();

  const builds = await findBuildsInEval(hydraApi, evaluation, _.map(downloads, d => d.job));

  if (_.isEmpty(builds) && !_.isEmpty(downloads)) {
    console.log("Didn't find any builds in evals.");
  } else {
    console.log("Waiting for builds to complete...");
  }

  const urls = await Promise.all(_.map(downloads, download => waitForBuild(hydraApi, builds[download.job], download.buildProducts)));

  timings.built = new Date();

  return {
    evaluation,
    evalURL: evaluation?.id ? `${hydraURL}eval/${evaluation.id}` : undefined,
    builds,
    buildURLs: _.map(builds, build => hydraBuildURL(hydraApi, build.id)),
    buildProductURLs: _.flatten(urls),
    timings
  };
}

async function waitForBuild(hydraApi: AxiosInstance, build: HydraBuild, buildProducts: number[]): Promise<string[]> {
  const buildURL = hydraBuildURL(hydraApi, build.id);
  const job = fullJobName(build);

  if (build.finished) {
    console.log(`${buildURL} (${job}) is finished.`);
    if (build.buildstatus === 0) {
      return _.map(buildProducts, num => hydraBuildProductDownloadURL(hydraApi, build, "" + num));
    } else {
      console.log(`Build failed: ${buildURL}/nixlog/1/tail`);
      return [];
    }
  } else {
    console.log(`${buildURL} (${job}) is not yet finished - retrying soon...`);
    await sleep(10000 + Math.floor(Math.random() * 5000));
    const refreshed = await fetchHydraBuild(hydraApi, build.id);
    return waitForBuild(hydraApi, refreshed.data, buildProducts);
  }
}
