import * as core from '@actions/core';
import * as github from '@actions/github';
import { run } from './action';

const INPUTS = {
  NOTION_TOKEN: 'notion-token',
  NOTION_TASK_DS: 'notion-task-ds',
  NOTION_PROJECT_DS: 'notion-project-ds',
  NOTION_USERS_DS: 'notion-users-ds',
  GITHUB_TOKEN: 'github-token',
};

async function start() {
  try {
    const notionToken = core.getInput(INPUTS.NOTION_TOKEN, { required: true });
    const notionTaskDs = core.getInput(INPUTS.NOTION_TASK_DS, { required: true });
    const notionProjectDs = core.getInput(INPUTS.NOTION_PROJECT_DS, { required: true });
    const notionUsersDs = core.getInput(INPUTS.NOTION_USERS_DS, { required: true });
    const githubToken = core.getInput(INPUTS.GITHUB_TOKEN, { required: true });

    core.info(`context event: ${github.context.eventName}`);
    core.info(`context action: ${github.context.action}`);
    core.info(`payload action: ${github.context.payload.action}`);

    const options = {
      notion: {
        token: notionToken,
        taskDataSourceId: notionTaskDs,
        projectDataSourceId: notionProjectDs,
        usersDataSourceId: notionUsersDs,
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
