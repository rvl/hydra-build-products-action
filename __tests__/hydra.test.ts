import { scrapeEvalHTML } from '../src/hydra'
import * as path from 'path'
import * as fs from 'fs'

test('scrapes build ids', async () => {

  const html = await fs.promises.readFile(path.join(__dirname, "eval.html"), 'utf8');

  const jobs = ["cardano-wallet-linux64", "cardano-wallet-macos64", "cardano-wallet-win64"];
  const buildIds = scrapeEvalHTML(jobs, html);
  expect(buildIds).toEqual({
    "cardano-wallet-linux64": 6259993,
    "cardano-wallet-macos64": 6259982,
    "cardano-wallet-win64": 6259976,
  });
})
