import { Client, LogLevel } from '@notionhq/client/build/src';
import * as core from '@actions/core';
import type { IssuesEvent, IssuesOpenedEvent } from '@octokit/webhooks-definitions/schema';
import type { WebhookPayload } from '@actions/github/lib/interfaces';
import { CustomValueMap, notionFields, properties } from './properties';
import { createIssueMapping, syncNotionDBWithGitHub } from './sync';
import { markdownToRichText } from '@tryfabric/martian';
import { CustomTypes } from './api-types';
import { CreatePageParameters } from '@notionhq/client/build/src/api-endpoints';

import { graphql } from '@octokit/graphql';
import { markdownToBlocks } from '@tryfabric/martian';

export const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${core.getInput('github-token', { required: true })}`,
  },
});

function removeHTML(text?: string): string {
  return text?.replace(/<.*>.*<\/.*>/g, '') ?? '';
}

// Returns single notion status based on GitHub issue state, Github issue labels from Github issue payload and project custom field "Status"
function getNotionStatusFromGithubIssue(payload: IssuesEvent, GithubProject?: ProjectData): string | null {
  if (payload.issue.state === "closed") {
    return "Done";
  }

  // Check if the issue has a label that indicates it's blocked
  if (payload.issue.labels?.some(label => label.name.toLowerCase() === 'blocked')) {
    return "Blocked";
  }

  // Check if issue has a lablel tha indicates it's duplicated
  if (payload.issue.labels?.some(label => label.name.toLowerCase() === 'duplicate')) {
    return "Duplicate";
  }

  if (GithubProject?.customFields?.['Status']) {
    return GithubProject.customFields['Status'] as string;
  }

  return null
}

interface PayloadParsingOptions {
  payload: IssuesEvent;
  userRelations: userRelationGithubNotionType[];
  notionProjects: NotionProjectInfo[];
}
async function parsePropertiesFromPayload(options: PayloadParsingOptions): Promise<CustomValueMap> {
  const { payload, userRelations, notionProjects } = options;

  const project = await getProject({
    githubRepo: payload.repository.full_name,
    issueNumber: payload.issue.number
  });

  // core.info(`Current project data: ${JSON.stringify(project, null, 2)}`);

  const result: CustomValueMap = {
    [notionFields.Name]: properties.title(payload.issue.title),
    [notionFields.Description]: properties.text(payload.issue.body ?? ''),
    [notionFields.Status]: properties.status(getNotionStatusFromGithubIssue(payload, project)),
    [notionFields.Repository]: properties.text(payload.repository.name),
    [notionFields.Assignee]: properties.person(payload.issue.assignees.map(assignee => assignee.login), userRelations),
    [notionFields.GithubIssue]: properties.url(payload.issue.html_url),
    [notionFields.Project]: properties.relation((project?.customFields && project?.customFields['Project KEY']) as string, notionProjects),
    [notionFields.TaskGroup]: properties.text("Development")
  };

  if (project?.customFields?.['Estimate']) {
    result[notionFields.EstimateHrs] = properties.number(project.customFields['Estimate'] as number);
  }

  return result;
}

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
): Promise<ProjectData> {
  const { githubRepo, issueNumber } = options;

  core.info(`Fetching projectsV2 for issue #${issueNumber} in repo ${githubRepo}`);

  // Updated GraphQL query to fetch all fields and field values
  // Pagination for projectsV2
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
                        field {
                          ... on ProjectV2FieldCommon {
                            id
                            name
                          }
                        }
                        name
                      }
                      ... on ProjectV2ItemFieldTextValue {
                        field {
                          ... on ProjectV2FieldCommon {
                            id
                            name
                          }
                        }
                        text
                      }
                      ... on ProjectV2ItemFieldNumberValue {
                        field {
                          ... on ProjectV2FieldCommon {
                            id
                            name
                          }
                        }
                        number
                      }
                    }
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
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
          nodes: Array<{
            id: string;
            number: number;
            title: string;
            url: string;
            fields: {
              nodes: Array<{
                id: string;
                name: string;
                dataType: string;
              }>;
            };
            items: {
              nodes: Array<{
                content: {
                  issueNumber: number;
                  state?: string;
                } | null;
                fieldValues: {
                  nodes: Array<{
                    field?: { id: string; name: string };
                    name?: string;
                    text?: string;
                    number?: number;
                  }>;
                };
              }>;
            };
          }>;
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
        };
      };
    };

    queryProjects = queryProjects.concat(projectsResponse.repository.projectsV2.nodes);
    hasNextPage = projectsResponse.repository.projectsV2.pageInfo.hasNextPage;
    endCursor = projectsResponse.repository.projectsV2.pageInfo.endCursor;
  }

  core.info(`Found ${queryProjects.length} projectsV2 in the repository.`);

  const projects: ProjectData[] = [];

  // Sort projects by its number
  queryProjects.sort((a, b) => a.number - b.number);

  for (const project of queryProjects) {
    for (const item of project.items.nodes) {
      // core.info(`Checking item with content: ${JSON.stringify(item)}`);
      if (item.content && item.content.issueNumber === issueNumber) {
        // Extract custom fields and their values
        const customFields: Record<string, string | number | null> = {};
        for (const fieldValue of item.fieldValues.nodes) {
          const fieldName = fieldValue.field?.name;
          let value: string | number | null = null;
          if (typeof fieldValue.number === 'number' && fieldValue.number !== undefined) {
            value = fieldValue.number;
          } else if (typeof fieldValue.text === 'string' && fieldValue.text !== undefined) {
            value = fieldValue.text;
          } else if (typeof fieldValue.name === 'string' && fieldValue.name !== undefined) {
            value = fieldValue.name;
          }
          if (fieldName) customFields[fieldName] = value;
        }

        projects.push({
          name: project.title,
          url: project.url,
          customFields,
        });
      }
    }
  }

  return projects[0];
}

/**
 * Represents a mapping between a GitHub username and a Notion user ID.
 *
 * @property githubUsername - The username of the user on GitHub.
 * @property notionUserId - The corresponding user ID in Notion.
 */
export interface userRelationGithubNotionType {
  githubUsername: string;
  notionUserId: string;
};

/**
 * Fetches relations between GitHub usernames and Notion user IDs from a Notion database.
 * Expects the database to have a 'GitHub' URL property and a 'Name' people property.
 *
 * @param notionClient - The Notion API client
 * @returns Array of objects mapping GitHub usernames to Notion user IDs
 */
export async function getRelationsBetweenGithubAndNotionUsers(
  notionClient: Client,
  notionUserDbId: string
): Promise<userRelationGithubNotionType[]> {
  const relations: userRelationGithubNotionType[] = [];
  const response = await notionClient.databases.query({
    database_id: notionUserDbId,
  });

  for (const result of response.results) {
    // Type guard: Ensure result is a full page object with properties
    if (
      result.object === 'page' &&
      'properties' in result
    ) {
      const githubProp = result.properties['GitHub'];
      const nameProp = result.properties['Name'];

      if (
        githubProp &&
        githubProp.type === 'url' &&
        githubProp.url &&
        nameProp &&
        nameProp.type === 'people' &&
        nameProp.people.length > 0
      ) {
        // Find the first person-type user in the people array
        const person = nameProp.people.find(
          (p) =>
            p.object === 'user' &&
            'type' in p && // Type guard for 'type'
            p.type === 'person' &&
            !!p.id
        );
        if (person) {
          const githubUrl = githubProp.url;
          const githubUsername = githubUrl.split('/').pop();
          if (githubUsername) {
            relations.push({
              githubUsername,
              notionUserId: person.id,
            });
          }
        }
      }
    }
  }

  return relations;
}

export function parseBodyRichText(body: string) {
  try {
    return markdownToRichText(removeHTML(body)) as CustomTypes.RichText['rich_text'];
  } catch {
    return [];
  }
}

export function getBodyChildrenBlocks(body: string): Exclude<CreatePageParameters['children'], undefined> {
  // Convert GitHub-flavored markdown to Notion blocks using martian
  try {
    const blocks = markdownToBlocks(removeHTML(body));
    return blocks as Exclude<CreatePageParameters['children'], undefined>;
  } catch (error) {
    core.warning(`Failed to parse markdown to Notion blocks: ${error}`);
    // Fallback to a single paragraph block
    return [
      {
        type: 'paragraph',
        paragraph: {
          rich_text: parseBodyRichText(body),
        },
      },
    ];
  }
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

  core.info(
    `Found ${users.length} relations between GitHub usernames and Notion user IDs`
  );

  const projects = await getNotionProjects(notion.client, notion.projectDatabaseId);

  core.info(`Found ${projects.length} Notion projects`);

  return {
    users,
    projects,
  };
}
interface IssueOpenedOptions {
  notion: {
    client: Client;
    taskDatabaseId: string;
    projectDatabaseId: string;
    usersDatabaseId: string;
  };
  payload: IssuesOpenedEvent;
}

async function handleIssueOpened(options: IssueOpenedOptions) {
  const { notion, payload } = options;

  core.info(`Creating task for issue #${payload.issue.html_url}`);

  // Skip if issue type is 'Feature'
  if (payload.issue.labels && payload.issue.labels.some(label => label.name === 'Feature')) {
    core.info(`Skipping issue #${payload.issue.html_url} because its type is 'Feature'`);
    return;
  }

  const notionRelations = await getNotionRelations(notion);

  await notion.client.pages.create({
    parent: {
      database_id: notion.taskDatabaseId,
    },
    properties: await parsePropertiesFromPayload({
      payload,
      userRelations: notionRelations.users,
      notionProjects: notionRelations.projects
    })
  });
}

interface IssueEditedOptions {
  notion: {
    client: Client;
    taskDatabaseId: string;
    projectDatabaseId: string;
    usersDatabaseId: string;
  };
  payload: IssuesEvent;
}

async function handleIssueEdited(options: IssueEditedOptions) {
  const { notion, payload } = options;

  core.info(`Querying database for task for github issue ${payload.issue.html_url}`);

  const query = await notion.client.databases.query({
    database_id: notion.taskDatabaseId,
    filter: {
      property: notionFields.GithubIssue,
      url: {
        equals: payload.issue.html_url,
      },
    },
    page_size: 1,
  });

  if (query.results.length > 0) {
    const pageId = query.results[0].id;

    core.info(`Query successful: Page ${pageId}`);
    core.info(`Updating page for issue #${payload.issue.html_url}`);

    const notionRelations = await getNotionRelations({
      client: notion.client,
      taskDatabaseId: notion.taskDatabaseId,
      projectDatabaseId: notion.projectDatabaseId,
      usersDatabaseId: notion.usersDatabaseId
    });

    await notion.client.pages.update({
      page_id: pageId,
      properties: await parsePropertiesFromPayload({
        payload,
        userRelations: notionRelations.users,
        notionProjects: notionRelations.projects
      }),
    });
  } else {
    core.warning(`Could not find task for github issue ${payload.issue.html_url}, creating a new one`);

    // Skip if issue type is 'Feature'
    if (payload.issue.labels && payload.issue.labels.some(label => label.name === 'Feature')) {
      core.info(`Skipping issue #${payload.issue.html_url} because its type is 'Feature'`);
      return;
    }

    const notionRelations = await getNotionRelations({
      client: notion.client,
      taskDatabaseId: notion.taskDatabaseId,
      projectDatabaseId: notion.projectDatabaseId,
      usersDatabaseId: notion.usersDatabaseId
    });

    await notion.client.pages.create({
      parent: {
        database_id: notion.taskDatabaseId,
      },
      properties: await parsePropertiesFromPayload({
        payload,
        userRelations: notionRelations.users,
        notionProjects: notionRelations.projects
      })
    });
  }
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

  // console.log(`GitHub event: ${JSON.stringify(github, null, 2)}`);

  if (github.payload.action === 'opened') {
    await handleIssueOpened({
      notion: {
        client: notionClient,
        taskDatabaseId: notion.taskDatabaseId,
        projectDatabaseId: notion.projectDatabaseId,
        usersDatabaseId: notion.usersDatabaseId
      },
      payload: github.payload as IssuesOpenedEvent,
    });
  } else if (github.eventName === 'workflow_dispatch') {
    core.info('Handling workflow_dispatch event');

    const notionClient = new Client({ auth: options.notion.token });
    const { taskDatabaseId } = options.notion;
    const issuePageIds = await createIssueMapping(notionClient, taskDatabaseId);

    if (!github.payload.repository?.full_name) {
      throw new Error('Unable to find repository name in github webhook context');
    }

    const githubRepo = github.payload.repository.full_name;
    await syncNotionDBWithGitHub(
      issuePageIds,
      notionClient,
      notion.taskDatabaseId,
      notion.projectDatabaseId,
      notion.usersDatabaseId,
      githubRepo
    );
  } else {
    await handleIssueEdited({
      notion: {
        client: notionClient,
        taskDatabaseId: notion.taskDatabaseId,
        projectDatabaseId: notion.projectDatabaseId,
        usersDatabaseId: notion.usersDatabaseId
      },
      payload: github.payload as IssuesEvent
    });
  }

  core.info('Complete!');
}

/**
 * Represents information about a Notion project.
 *
 * @property id - The unique identifier of the Notion project.
 * @property projectKey - The key associated with the Notion project.
 */
export interface NotionProjectInfo {
  id: string;
  projectKey: string;
}

/**
 * Retrieves a list of Notion projects from a specified Notion database.
 *
 * This function queries the Notion database using the provided Notion client,
 * filters out trashed pages, and extracts project information for pages that
 * have a valid 'Project KEY' property of type 'formula' with a non-empty string value.
 *
 * @param notionClient - An instance of the Notion API client used to query the database.
 * @returns A promise that resolves to an array of `NotionProjectInfo` objects,
 *          each containing the page ID and the associated project key.
 *
 * @throws Will propagate any errors thrown by the Notion client during the database query.
 */
export async function getNotionProjects(
  notionClient: Client,
  notionProjectDbId: string
): Promise<NotionProjectInfo[]> {
  const databaseId = notionProjectDbId;
  let hasMore = true;
  let startCursor: string | undefined = undefined;
  const projects: NotionProjectInfo[] = [];

  while (hasMore) {
    const response = await notionClient.databases.query({
      database_id: databaseId,
      start_cursor: startCursor,
      page_size: 100,
    });

    for (const result of response.results) {
      if (
        result.object === 'page' &&
        'in_trash' in result &&
        result.in_trash === false &&
        'properties' in result &&
        result.properties &&
        'Project KEY' in result.properties &&
        result.properties['Project KEY'] &&
        result.properties['Project KEY'].type === 'formula' &&
        'formula' in result.properties['Project KEY'] &&
        result.properties['Project KEY'].formula.type === 'string' &&
        result.properties['Project KEY'].formula.string &&
        result.properties['Project KEY'].formula.string.length > 0
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
