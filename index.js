// This github actions workflow queries evaluation and build product
// urls from Hydra.
// Adapted from cardano-wallet/scripts/travis-download-builds.js

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const _ = require('lodash');
const core = require('@actions/core');
const github = require('@actions/github');

function makeHydraApi(hydraURL, options = {}) {
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

function makeGitHubApi(options = {}) {
  const api = axios.create(_.merge({
    baseURL: "https://api.github.com/",
    headers: { "Content-Type": "application/json" },
  }, options));
  api.interceptors.request.use(request => {
    console.debug(`${request.method} ${request.baseURL}${request.url}`);
    return request;
  });
  return api;
}

async function findEvalByCommit(api, project, jobset, rev, page)  {
  const evalsPath = `jobset/${project}/${jobset}/evals${page || ""}`;
  const r = await api.get(jobPath);

  const eval = _.find(r.data.evals, e => e.jobsetevalinputs["cardano-wallet"].revision === rev);

  if (eval) {
    return eval;
  } else if (r.data.next) {
    return findEvalByCommit(api, project, jobset, rev, r.data.next);
  } else {
    return undefined;
  }
}

function findCardanoWalletEval(api, rev) {
  return findEvalByCommit(apiapi, "Cardano", "cardano-wallet", rev);
}

async function findEvalsFromGitHub(hydra, github, owner, repo, rev, page) {
  const q = "?per_page=100" + (page ? `&page=${page}` : "");
  const r = await github.get(`repos/${owner}/${repo}/commits/${rev}/statuses${q}`);

  const retry = async () => {
    console.log(`Eval not found, and no more pages from GitHub.`);
    console.log(`Waiting for updated CI status.`);
    await sleep(60000);
    return await findEvalsFromGitHub(hydra, github, owner, repo, rev);
  }

  if (_.isEmpty(r.data)) {
    return await retry();
  }

  const statuses = _.filter(r.data, status => status.context.startsWith("ci/hydra-eval"));
  const successful = _.filter(statuses, { state: "success" });
  const pending = _.filter(statuses, { state: "pending" });
  const failed = _.difference(statuses, successful, pending);

  console.log("statuses", JSON.stringify(statuses));

  console.log(`Found ${statuses.length} eval statuses:  successful=${successful.length}  pending=${pending.length}  failed=${failed.length}`);

  let evals = [];
  for await (const status of successful) {
    const eval = await hydra.get(status.target_url);
    if (!_.isEmpty(eval.data)) {
      evals.push(eval.data);
    }
  }

  if (_.isEmpty(evals)) {
    if (pending.length) {
      console.log("Eval is pending - trying again...");
      return await waitForPendingEval(hydra, repo, rev, pending);
    } else if (failed.length) {
      console.error("Can't get eval - it was not successful.");
      return null;
    } else if (r.headers["Link"]) {
      const next = (page || 1) + 1;
      console.log(`Eval not found - trying page ${next}`);
      return await findEvalsFromGitHub(hydra, github, owner, repo, rev, next);
    } else {
      console.log(`Eval not found`);
      return await retry();
    }
  } else {
    return evals;
  }
}

async function waitForPendingEval(hydra, srcName, rev, pendings) {
  await sleep(10000);

  let evals = [];
  for await (const pending of pendings) {
    const jobset = await hydra.get(pending.target_url);
    if (jobset.data.errormsg) {
      console.log(`There is a currently an evaluation error for jobset: ${pending.target_url}`);
    }

    const evalsURL = pending.target_url.replace(/#.*$/, "/evals");
    const jobsetEvals = await hydra.get(evalsURL);
    console.log(JSON.stringify(jobsetEvals.data));
    console.log(`There are ${jobsetEvals.data.evals.length} eval(s)`);
    const eval = _.find(jobsetEvals.data.evals, e => e.jobsetevalinputs[srcName] && e.jobsetevalinputs[srcName].revision === rev);
    if (eval) {
      console.log("Found eval", eval);
      evals.push(eval);
    }
  }

  if (_.isEmpty(evals)) {
    console.log("Eval is still pending - trying again...");
    return waitForPendingEval(hydra, srcName, rev, pendings);
  } else {
    return evals;
  }
}

async function findBuildsInEvals(api, evals, jobs) {
  let builds = {};
  for (const eval of evals) {
    for (const build of eval.builds) {
      const r = await api.get(`build/${build}`);
      if (_.includes(jobs, r.data.job)) {
        console.log(`Found ${r.data.job}`);
        builds[r.data.job] = r.data;
        if (_.size(builds) === _.size(jobs)) {
          break;
        }
      }
    }
  }
  return builds;
}

async function downloadBuildProduct(hydraURL, build, number) {
  const buildProduct = build.buildproducts[number];
  const filename = buildProduct.name;
  return `${hydraURL}build/${build.id}/download/${number}/${filename}`;
}

async function download(hydraURL, downloadSpec, jobs, options = {}) {
  const hydraApi = makeHydraApi(hydraURL, options);
  const github = makeGitHubApi(options);

  const evals = await findEvalsFromGitHub(hydraApi, github, downloadSpec.owner, downloadSpec.repo, downloadSpec.rev);
  console.log(`${evals.length} eval(s) has ${_.sumBy(evals, eval => eval.builds.length)} builds`);

  const downloads = downloadSpec.jobs;

  const builds = await findBuildsInEvals(hydraApi, evals, _.map(downloads, "job"));

  let urls = [];

  if (_.isEmpty(builds)) {
    console.log("Didn't find any builds in evals.");
  } else {
    for (let i = 0; i < downloads.length; i++) {
      const build = builds[downloads[i].job];
      for (let j = 0; j < downloads[i].buildProducts.length; j++) {
        urls.push(await downloadBuildProduct(hydraURL, build, "" + downloads[i].buildProducts[j]));
      }
    }
  }

  return {
    evalIDs: _.map(evals, "id"),
    evalURLs: _.map(evals, eval => `${hydraURL}eval/${eval.id}`),
    buildURLs: _.map(builds, build => `${hydraURL}build/${build.id}`),
    buildProducts: urls,
    builds: builds,
    evals: evals
  };
}

function sleep(ms = 0) {
  return new Promise(r => setTimeout(r, ms));
};

async function main() {
  const hydraURL = process.env.HYDRA_URL || core.getInput('hydra');
  const jobs = (process.env.HYDRA_JOBS || core.getInput('jobs')).split(/ /);
  console.log("INPUT hydraURL:", hydraURL);
  console.log("INPUT jobs:", jobs);

  const payload = github.context.payload;
  console.log("github payload:", payload);

  const spec = {
    owner: process.env.REPO_OWNER || payload.repository.owner.login,
    repo: process.env.REPO_NAME || payload.repository.name,
    rev: process.env.COMMIT || payload.after,
    jobs: _.map(jobs, name => { return { job: name, buildProducts: [1] }; })
  };

  const res = await download(hydraURL, spec);

  console.log("OUTPUT evals:", res.evalURLs);
  console.log("OUTPUT builds:", res.buildURLs);
  console.log("OUTPUT buildProducts:", res.buildProducts);

  core.setOutput("evals", res.evalURLs.join(" "));
  core.setOutput("builds", res.buildURLs.join(" "));
  core.setOutput("buildProducts", res.buildProducts.join(" "));
}

main()
  .then(() => { console.log("done"); })
  .catch(error => { core.setFailed(error.message); });
