import * as github from '@actions/github';
import _ from 'lodash';
import {AxiosResponse, AxiosRequestConfig, AxiosInstance} from 'axios';
import axios from 'axios';

//////////////////////////////////////////////////////////////////////
// GitHub event context

export interface ActionContext {
  repo: GitHubRepo;
  previousStatus?: GitHubStatus;
  eventName?: string;
  payload?: any;
}

export interface GitHubRepo {
  owner: string;
  name: string;
  rev: string;
};

export function validateRepo(repo: GitHubRepo): void {
  for (const what of ["owner", "name", "rev"]) {
    if (!(<any>repo)[what]) {
      throw new Error(`${what} missing from github payload`);
    }
  }
}

export interface GitHubStatus {
  context: string;
  state: string;
  target_url: string;
}

export function getActionPayload(): ActionContext {
  const eventName = github?.context?.eventName;
  const payload = github?.context?.payload;

  const statusEvent = eventName === "status" ? payload : undefined;
  const pushEvent = eventName === "push" ? payload : undefined;
  const tagEvent = eventName === "push" && payload?.ref?.startsWith("refs/tags/") ? payload : undefined;
  const prEvent = eventName === "pull_request" ? payload : undefined;

  return {
    repo: {
      owner: process.env.REPO_OWNER || payload?.repository?.owner?.login || "",
      name: process.env.REPO_NAME || payload?.repository?.name || "",
      rev: process.env.COMMIT || tagEvent?.head_commit?.id || pushEvent?.after || prEvent?.pull_request?.head?.sha || statusEvent?.sha || "",
    },
    previousStatus: statusEvent ? { context: statusEvent.context, state: statusEvent.state, target_url: statusEvent.target_url } : undefined,
    eventName,
    payload,
  };
}

//////////////////////////////////////////////////////////////////////
// GitHub API Requests

export function makeGitHubApi(options = {}): AxiosInstance {
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
// GitHub Status API

export async function fetchGitHubStatus(githubApi: AxiosInstance, { owner, name, rev}: GitHubRepo, statusName: string, previousStatus?: GitHubStatus, page?: number) {
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
