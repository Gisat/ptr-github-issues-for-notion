import { Client, LogLevel } from '@notionhq/client/build/src';
import * as core from '@actions/core';
import type { WebhookPayload } from '@actions/github/lib/interfaces';
import { syncGithubIssuesWithNotionTasks } from './sync';
import { graphql } from '@octokit/graphql';

export const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${core.getInput('github-token', { required: true })}`,
  },
});

export interface ProjectData {
  name: string;
  url: string;
  customFields?: Record<string, string | number | null>;
}

interface GetProjectDataOptions {
  githubRepo: string;
  issueNumber: number;
}

export async function getProject(
  options: GetProjectDataOptions
): Promise<ProjectData | undefined> {
  const { githubRepo, issueNumber } = options;
  core.info(`Fetching projectsV2 for issue #${issueNumber} in repo ${githubRepo}`);

  let queryProjects: any[] = [];
  let hasNextPage = true;
  let endCursor: string | null = null;

  while (hasNextPage) {
    const projectsResponse = await graphqlWithAuth(
      `
      query($owner: String!, $repo: String!, $after: String) {
        repository(owner: $owner, name: $repo) {
          projectsV2(first: 20, after: $after) {
            nodes {
              id
              number
              title
              url
              fields(first: 20) {
                nodes {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                    dataType
                  }
                }
              }
              items(first: 100) {
                nodes {
                  content {
                    ... on Issue {
                      issueNumber: number
                      state
                    }
                  }
                  fieldValues(first: 20) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        field { ... on ProjectV2FieldCommon { id name } }
                        name
                      }
                      ... on ProjectV2ItemFieldTextValue {
                        field { ... on ProjectV2FieldCommon { id name } }
                        text
                      }
                      ... on ProjectV2ItemFieldNumberValue {
                        field { ... on ProjectV2FieldCommon { id name } }
                        number
                      }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      `,
      {
        owner: githubRepo.split('/')[0],
        repo: githubRepo.split('/')[1],
        after: endCursor,
      }
    ) as {
      repository: {
        projectsV2: {
          nodes: Array<any>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };

    queryProjects = queryProjects.concat(projectsResponse.repository.projectsV2.nodes);
    hasNextPage = projectsResponse.repository.projectsV2.pageInfo.hasNextPage;
    endCursor = projectsResponse.repository.projectsV2.pageInfo.endCursor;
  }

  core.info(`Found ${queryProjects.length} projectsV2 in the repository.`);
  queryProjects.sort((a, b) => a.number - b.number);

  for (const project of queryProjects) {
    console.log(`Project:`, JSON.stringify(project));
    for (const item of project.items.nodes) {
      if (item.content && item.content.issueNumber === issueNumber) {
        const customFields: Record<string, string | number | null> = {};
        for (const fieldValue of item.fieldValues.nodes) {
          const fieldName = fieldValue.field?.name;
          let value: string | number | null = null;
          if (typeof fieldValue.number === 'number') value = fieldValue.number;
          else if (typeof fieldValue.text === 'string') value = fieldValue.text;
          else if (typeof fieldValue.name === 'string') value = fieldValue.name;
          if (fieldName) customFields[fieldName] = value;
        }
        return {
          name: project.title,
          url: project.url,
          customFields,
        };
      }
    }
  }

  return undefined;
}

export interface userRelationGithubNotionType {
  githubUsername: string;
  notionUserId: string;
}

export async function getRelationsBetweenGithubAndNotionUsers(
  notionClient: Client,
  notionUserDbId: string
): Promise<userRelationGithubNotionType[]> {
  const relations: userRelationGithubNotionType[] = [];
  const response = await notionClient.databases.query({ database_id: notionUserDbId });

  for (const result of response.results) {
    if (
      result.object === 'page' &&
      'properties' in result
    ) {
      const githubProp = result.properties['GitHub'];
      const nameProp = result.properties['Name'];
      if (
        githubProp?.type === 'url' &&
        githubProp.url &&
        nameProp?.type === 'people' &&
        nameProp.people.length > 0
      ) {
        const person = nameProp.people.find(
          (p) => p.object === 'user' && !!p.id
        );
        if (person) {
          const githubUsername = githubProp.url.split('/').pop();
          if (githubUsername) {
            relations.push({ githubUsername, notionUserId: person.id });
          }
        }
      }
    }
  }
  return relations;
}

export interface NotionProjectInfo {
  id: string;
  projectKey: string;
}

export async function getNotionProjects(
  notionClient: Client,
  notionProjectDbId: string
): Promise<NotionProjectInfo[]> {
  let hasMore = true;
  let startCursor: string | undefined = undefined;
  const projects: NotionProjectInfo[] = [];

  while (hasMore) {
    const response = await notionClient.databases.query({
      database_id: notionProjectDbId,
      start_cursor: startCursor,
      page_size: 100,
    });

    for (const result of response.results) {
      if (
        result.object === 'page' &&
        'in_trash' in result &&
        result.in_trash === false &&
        'properties' in result &&
        result.properties['Project KEY']?.type === 'formula' &&
        result.properties['Project KEY'].formula.type === 'string' &&
        result.properties['Project KEY'].formula.string
      ) {
        projects.push({
          id: result.id,
          projectKey: result.properties['Project KEY'].formula.string,
        });
      }
    }
    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }
  return projects;
}

export interface NotionRelationsInterface {
  users: userRelationGithubNotionType[];
  projects: NotionProjectInfo[];
}

interface NotionRelationsOptions {
  client: Client;
  taskDatabaseId: string;
  projectDatabaseId: string;
  usersDatabaseId: string;
}

export async function getNotionRelations(notion: NotionRelationsOptions): Promise<NotionRelationsInterface> {
  const users = await getRelationsBetweenGithubAndNotionUsers(notion.client, notion.usersDatabaseId);
  core.info(`Found ${users.length} relations between GitHub usernames and Notion user IDs`);
  const projects = await getNotionProjects(notion.client, notion.projectDatabaseId);
  core.info(`Found ${projects.length} Notion projects`);
  return { users, projects };
}

interface Options {
  notion: {
    token: string;
    taskDatabaseId: string;
    projectDatabaseId: string;
    usersDatabaseId: string;
  };
  github: {
    payload: WebhookPayload;
    eventName: string;
    token: string;
  };
}

export async function run(options: Options) {
  const { notion, github } = options;
  core.info('Starting...');
  const notionClient = new Client({
    auth: notion.token,
    logLevel: core.isDebug() ? LogLevel.DEBUG : LogLevel.WARN,
  });

  if (github.eventName === 'workflow_dispatch' || github.eventName === 'schedule') {
    core.info('Handling workflow_dispatch or schedule event');
    const repoFullName =
      github.payload.repository?.full_name ||
      process.env.GITHUB_REPOSITORY;
    if (!repoFullName) {
      throw new Error('Unable to find repository name in github webhook context or environment');
    }
    await syncGithubIssuesWithNotionTasks(
      notionClient,
      notion.taskDatabaseId,
      notion.projectDatabaseId,
      notion.usersDatabaseId,
      repoFullName
    );
  }
  core.info('Complete!');
}
