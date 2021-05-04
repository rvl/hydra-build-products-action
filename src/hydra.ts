// import fs from 'fs';
// import path from 'path';
// import * as github from '@actions/github';

import {AxiosRequestConfig, AxiosResponse, AxiosInstance} from 'axios';
import axios from 'axios';
import _ from 'lodash';
import { shieldsIO } from './shields';

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

export interface HydraEval {
  id: number; // evaluation id
  builds: number[]; // a list of build ids
  jobsetevalinputs: { [name: string]: HydraJobsetEvalInput; };
  hasnewbuilds: number; // some flag
  errormsg?: string; // evaluation error, if any
}

export interface HydraJobsetEvalInput {
  uri: string
  value: string;
  revision: string;
  type: string;
}

export interface HydraJobsetEvals {
  evals: HydraEval[];
  next: string; // relative url for next page
  first: string; // relative url for first page
  last: string; // relative url for last page
}

export interface HydraBuilds {
  [jobName: string]: HydraBuild;
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

export interface HydraBuildProducts {
  [id: string]: HydraBuildProduct;
}

export interface HydraBuildProduct {
  name: string;
  type: string;
  path: string;
}

function findEvalByInput(evals: HydraEval[], repo: GitHubRepo) {
  return _.find(evals, e => e.jobsetevalinputs[repo.name] && e.jobsetevalinputs[repo.name].revision === repo.rev);
}

function sleep(ms = 0): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
};

export interface GitHubStatus {
  context: string;
  state: string;
  target_url: string;
}

async function fetchGitHubStatus(githubApi: AxiosInstance, { owner, name, rev}: GitHubRepo, statusName: string, previousStatus?: GitHubStatus, page?: number) {
  if (previousStatus && previousStatus.context.startsWith(statusName)) {
    return {
      statuses: _([previousStatus]),
      nextPage: null,
    };
  } else {
    const q = "?per_page=100" + (page ? `&page=${page}` : "");
    const response: AxiosResponse<GitHubStatus[]> = await githubApi.get(`repos/${owner}/${name}/commits/${rev}/statuses${q}`);

    return {
      statuses: _(response.data).filter(st => st.context.startsWith(statusName)).sortBy("updated_at").reverse(),
      nextPage: response.headers["Link"],
    };
  }
}

async function findEvalFromGitHubStatus(hydraApi: AxiosInstance, githubApi: AxiosInstance, repo: GitHubRepo, statusName: string, previousStatus?: GitHubStatus, onPending: () => void = (() => undefined), page?: number): Promise<HydraEval|undefined> {

  const { statuses, nextPage } = await fetchGitHubStatus(githubApi, repo, statusName, previousStatus, page);

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

  const retry = (page?: number) => findEvalFromGitHubStatus(hydraApi, githubApi, repo, statusName, previousStatus, onPending, page);

  if (evaluation) {
    console.log(`Eval ${evaluation.id} is successful and has ${evaluation.builds.length} builds`);
    return evaluation;
  } else if (statuses.isEmpty()) {
    if (nextPage) {
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

async function fetchBuildFromCIStatus(hydraApi: AxiosInstance, previousStatus?: GitHubStatus): Promise<HydraBuilds> {
  if (previousStatus) {
    const path = previousStatus.target_url.match(/^.*\/build\/(\d+)$/);
    if (path) {
      const response = await fetchHydraBuild(hydraApi, parseInt(path[1], 10));
      return Object.fromEntries([[response.data.job, response.data]]);
    }
  }
  return {};
}

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

function filterBuildProducts(build: HydraBuild, buildProducts: number[] | null) {
  return (_.isEmpty(buildProducts))
    ? _.keys(build.buildproducts)
    : _.map(buildProducts, num => "" + num);
}

function hydraBuildProductDownloadURL(hydraApi: AxiosInstance, build: HydraBuild, num: string) {
  const buildProduct = build.buildproducts[num];
  const filename = buildProduct.name;
  return `${hydraBuildURL(hydraApi, build.id)}/download/${num}/${filename}`;
}

function fullJobName(build: HydraBuild): string {
  return `${build.project}:${build.jobset}:${build.job}`;
}

function buildStatus(build: HydraBuild): string {
  return !!build.finished
    ? (build.buildstatus === 0 ? "succeeded" : "failed")
    : (!!build.starttime ? "building" : "queued");
}

function hydraEvalURL(hydraURL: string, evaluation?: HydraEval) {
  return evaluation?.id ? `${hydraURL}eval/${evaluation.id}` : undefined;
}

function hydraJobsetURL({ hydraURL, project, jobset }: { hydraURL: string, project?: string, jobset?: string }) {
  return (project && jobset) ? `${hydraURL}jobset/${project}/${jobset}` : undefined;
}

//////////////////////////////////////////////////////////////////////
// Build polling

async function waitForBuild(hydraApi: AxiosInstance, build: HydraBuild, buildProducts: number[] | null): Promise<string[]> {
  const buildURL = hydraBuildURL(hydraApi, build.id);
  const job = fullJobName(build);

  console.log(`${buildURL} (${job}) is ${buildStatus(build)}.`);

  if (build.finished) {
    if (build.buildstatus === 0) {
      return _.map(filterBuildProducts(build, buildProducts), num => hydraBuildProductDownloadURL(hydraApi, build, num));
    } else {
      console.log(`Build log here: ${buildURL}/nixlog/1/tail`);
      return [];
    }
  } else {
    console.log(`Retrying shortly...`);
    await sleep(10000 + Math.floor(Math.random() * 5000));
    const refreshed = await fetchHydraBuild(hydraApi, build.id);
    return waitForBuild(hydraApi, refreshed.data, buildProducts);
  }
}

//////////////////////////////////////////////////////////////////////
// Build status badge

export function makeBadgeURL(info: { hydraURL: string; project?: string; jobset?: string; requiredJob?: string; }, evaluation?: HydraEval, builds: HydraBuilds = {}, opts?: { [key: string]: string }): string {
  const evalErr = !evaluation || evaluation.errormsg;
  const numPass = _(builds).values().filter(build => build.buildstatus === 0).size();
  const numFail = _(builds).values().filter(build => !!build.finished && build.buildstatus !== 0).size();
  const numPending = _(builds).values().filter(build => !build.finished).size();
  const job = info.requiredJob;
  const requiredJob = job ? _.find(builds, { job }) : undefined;
  const success = job ? requiredJob?.buildstatus === 0 : numFail === 0;
  const finished = job ? requiredJob?.finished : numPending === 0;
  return shieldsIO(_.assign({
    label: "Hydra",
    logo: "nixos",
    labelColor: "eeeeee",
    message: (evalErr ? `⚠ Eval | ` : ``)
      + `✓ ${numPass}`
      + (numFail ? ` | ❌ ${numFail}` : ``)
      + (numPending ? ` | ⌛ ${numPending} ` : ``),
    color: evalErr ? "important" : (finished ? (success ? "success" : "critical") : "inactive"),
    style: "for-the-badge",
    cacheSeconds: 900,
    link: [hydraJobsetURL(info),
           hydraEvalURL(info.hydraURL, evaluation)]
  }, opts));
}

//////////////////////////////////////////////////////////////////////
// Main action

/** Inputs to the action */
export interface HydraParams {
  hydraURL: string;
  requestOptions?: { [key: string]: any };
  jobs: string[];
  spec: Spec;
  downloads: Download[];
  statusName: string;
  requiredJob?: string;
  project?: string;
  jobset?: string;
  previous?: {
    status?: GitHubStatus;
    evaluation?: HydraEval;
    builds?: HydraBuilds;
  };
}

export interface GitHubRepo {
  owner: string;
  name: string;
  rev: string;
};

export interface Spec {
  repo: GitHubRepo;
  previousStatus?: GitHubStatus;
  eventName?: string;
  payload?: any;
}

export interface Download {
  job: string;
  buildProducts: number[] | null; /* null means get all */
}

export interface Result {
  evaluation?: HydraEval;
  evalURL?: string;
  builds: HydraBuilds;
  buildURLs: string[];
  buildProductURLs: string[];
  timings: Timings;
  badge: string;
}

export interface Timings {
  actionStarted: Date;
  ciStatusCreated?: Date;
  evaluated?: Date;
  foundBuilds?: Date;
  built?: Date;
}

export function formatTimings(timings: Timings) {
  return _.mapValues(timings, d => d?.toISOString());
}

function validateRepo(repo: GitHubRepo): void {
  for (const what of ["owner", "name", "rev"]) {
    if (!(<any>repo)[what]) {
      throw new Error(`${what} missing from github payload`);
    }
  }
}

export async function hydra(params: HydraParams): Promise<Result> {
  const timings: Timings = { actionStarted: new Date() };
  const onPending = () => {
    timings.ciStatusCreated = timings.ciStatusCreated || new Date();
  };

  const hydraApi = makeHydraApi(params.hydraURL, params.requestOptions || {});
  const githubApi = makeGitHubApi(params.requestOptions || {});

  let evaluation = params.previous?.evaluation;

  if (_.isEmpty(evaluation)) {
    validateRepo(params.spec.repo);
    evaluation = await findEvalFromGitHubStatus(hydraApi, githubApi, params.spec.repo, params.statusName, params.previous?.status, onPending);
    if (!evaluation) {
      const msg = "Couldn't get eval from GitHub status API.";
      console.error(msg);
      throw new Error(msg);
    }
  } else {
    console.log(`Eval ${evaluation?.id} has ${evaluation?.builds?.length} builds`);
  }

  timings.evaluated = new Date();

  let builds = params.previous?.builds
    || await fetchBuildFromCIStatus(hydraApi, params.previous?.status)
    || {};

  // TODO: cache info for every build in the map so that it can be
  // re-used.
  if (_.isEmpty(builds)) {
    builds = await findBuildsInEval(hydraApi, <HydraEval>evaluation, _.map(params.downloads, d => d.job));
  }

  timings.foundBuilds = new Date();

  if (_.isEmpty(builds) && !_.isEmpty(params.downloads)) {
    console.log("Didn't find any builds in evals.");
  } else {
    console.log("Waiting for builds to complete...");
  }

  const urls = await Promise.all(_.map(params.downloads, download => waitForBuild(hydraApi, builds[download.job], download.buildProducts)));

  timings.built = new Date();

  return {
    evaluation,
    evalURL: hydraEvalURL(params.hydraURL, evaluation),
    builds,
    buildURLs: _.map(builds, build => hydraBuildURL(hydraApi, build.id)),
    buildProductURLs: _.flatten(urls),
    timings,
    badge: makeBadgeURL(params, evaluation, builds)
  };
}
