import * as core from '@actions/core';
import * as github from '@actions/github';
import { run } from './action';

const INPUTS = {
  NOTION_TOKEN: 'notion-token',
  NOTION_TASK_DB: 'notion-task-db',
  NOTION_PROJECT_DB: 'notion-project-db',
  NOTION_USERS_DB: 'notion-users-db',
  GITHUB_TOKEN: 'github-token',
};

async function start() {
  try {
    const notionToken = core.getInput(INPUTS.NOTION_TOKEN, { required: true });
    const notionTaskDb = core.getInput(INPUTS.NOTION_TASK_DB, { required: true });
    const notionProjectDb = core.getInput(INPUTS.NOTION_PROJECT_DB, { required: true });
    const notionUsersDb = core.getInput(INPUTS.NOTION_USERS_DB, { required: true });
    const githubToken = core.getInput(INPUTS.GITHUB_TOKEN, { required: true });

    core.info(`context event: ${github.context.eventName}`);
    core.info(`context action: ${github.context.action}`);
    core.info(`payload action: ${github.context.payload.action}`);

    const options = {
      notion: {
        token: notionToken,
        taskDatabaseId: notionTaskDb,
        projectDatabaseId: notionProjectDb,
        usersDatabaseId: notionUsersDb
      },
      github: {
        payload: github.context.payload,
        eventName: github.context.eventName,
        token: githubToken,
      },
    };

    await run(options);
  } catch (e) {
    core.setFailed(e instanceof Error ? e.message : e + '');
  }
}

(async () => {
  await start();
})();
