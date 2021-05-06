import { scrapeEvalHTML, scrapeBuildsInEval, makeHydraApi } from '../src/hydra'
import * as path from 'path'
import * as fs from 'fs'
import * as _ from 'lodash';

const jobs = ["cardano-wallet-linux64", "cardano-wallet-macos64", "cardano-wallet-win64"];
const evalId = 1053499;
const jobIds = {
    "cardano-wallet-linux64": 6259993,
    "cardano-wallet-macos64": 6259982,
    "cardano-wallet-win64": 6259976,
};
const hydraApi = makeHydraApi("https://hydra.iohk.io/");

test('scrapes build ids', async () => {
  const html = await fs.promises.readFile(path.join(__dirname, "eval.html"), 'utf8');

  expect(scrapeEvalHTML(jobs, html)).toEqual(jobIds);
});

test('fetch and scrapes', async () => {
  const res = await scrapeBuildsInEval(hydraApi, evalId, jobs);
  expect(_.mapValues(res, "id")).toEqual(jobIds);
}, 30000);
