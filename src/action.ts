import { Client, LogLevel } from '@notionhq/client/build/src';
import * as core from '@actions/core';
import type { IssuesEvent, IssuesOpenedEvent } from '@octokit/webhooks-definitions/schema';
import type { WebhookPayload } from '@actions/github/lib/interfaces';
import { CustomValueMap, properties } from './properties';
import { createIssueMapping, syncNotionDBWithGitHub } from './sync';
import { markdownToRichText } from '@tryfabric/martian';
import { CustomTypes } from './api-types';
import { CreatePageParameters } from '@notionhq/client/build/src/api-endpoints';

import { graphql } from '@octokit/graphql';

export const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${core.getInput('github-token', { required: true })}`,
  },
});

function removeHTML(text?: string): string {
  return text?.replace(/<.*>.*<\/.*>/g, '') ?? '';
}

interface PayloadParsingOptions {
  payload: IssuesEvent;
  userRelations: userRelationGithubNotionType[];
  notionProjects: NotionProjectInfo[];
}
async function parsePropertiesFromPayload(options: PayloadParsingOptions): Promise<CustomValueMap> {
  const { payload, userRelations, notionProjects } = options;

  payload.issue.labels?.map(label => label.color);

  const project = await getProject({
    githubRepo: payload.repository.full_name,
    issueNumber: payload.issue.number
  });

  // core.info(`Current project data: ${JSON.stringify(project, null, 2)}`);

  const result: CustomValueMap = {
    Name: properties.title(payload.issue.title),
    Status: properties.status(project.customFields?.['Status'] as string),
    Repository: properties.text(payload.repository.name),
    Assignee: properties.person(payload.issue.assignees.map(assignee => assignee.login), userRelations),
    Labels: properties.multiSelect(payload.issue.labels?.map(label => label.name) ?? []),
    Issue: properties.url(payload.issue.html_url),
    Project: properties.relation((project.customFields && project.customFields['Project KEY']) as string, notionProjects),
    'Task group': properties.text("Development")
  };

  core.info(`Parsed properties: ${JSON.stringify(result, null, 2)}`);

  return result;
}

interface ProjectData {
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

  for (const project of queryProjects) {
    for (const item of project.items.nodes) {
      // core.info(`Checking item with content: ${JSON.stringify(item)}`);
      if (item.content && item.content.issueNumber === issueNumber) {
        // Extract custom fields and their values
        const customFields: Record<string, string | number | null> = {};
        for (const fieldValue of item.fieldValues.nodes) {
          const fieldName = fieldValue.field?.name;
          let value: string | number | null = null;
          if ('name' in fieldValue && fieldValue.name) value = fieldValue.name;
          if ('text' in fieldValue && fieldValue.text) value = fieldValue.text;
          if ('number' in fieldValue && fieldValue.number !== undefined) value = fieldValue.number;
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
  notionClient: Client
): Promise<userRelationGithubNotionType[]> {
  const relations: userRelationGithubNotionType[] = [];
  const response = await notionClient.databases.query({
    database_id: '1b19b8aa93f343fa9ac4a553c92232db',
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

function getBodyChildrenBlocks(body: string): Exclude<CreatePageParameters['children'], undefined> {
  // We're currently using only one paragraph block, but this could be extended to multiple kinds of blocks.
  return [
    {
      type: 'paragraph',
      paragraph: {
        rich_text: parseBodyRichText(body),
      },
    },
  ];
}

export interface NotionRelationsInterface {
  users: userRelationGithubNotionType[];
  projects: NotionProjectInfo[];
}

export async function getNotionRelations(client: Client): Promise<NotionRelationsInterface> {
  const users = await getRelationsBetweenGithubAndNotionUsers(client);

  core.info(
    `Found ${users.length} relations between GitHub usernames and Notion user IDs`
  );

  const projects = await getNotionProjects(client);

  core.info(`Found ${projects.length} Notion projects`);

  return {
    users,
    projects,
  };
}
interface IssueOpenedOptions {
  notion: {
    client: Client;
    databaseId: string;
  };
  payload: IssuesOpenedEvent;
}

async function handleIssueOpened(options: IssueOpenedOptions) {
  const { notion, payload } = options;

  core.info(`Creating task for issue #${payload.issue.html_url}`);

  const notionRelations = await getNotionRelations(notion.client);

  await notion.client.pages.create({
    parent: {
      database_id: notion.databaseId,
    },
    properties: await parsePropertiesFromPayload({
      payload,
      userRelations: notionRelations.users,
      notionProjects: notionRelations.projects
    }),
    children: getBodyChildrenBlocks(payload.issue.body),
  });
}

interface IssueEditedOptions {
  notion: {
    client: Client;
    databaseId: string;
  };
  payload: IssuesEvent;
}

async function handleIssueEdited(options: IssueEditedOptions) {
  const { notion, payload } = options;

  core.info(`Querying database for task for github issue ${payload.issue.html_url}`);

  const query = await notion.client.databases.query({
    database_id: notion.databaseId,
    filter: {
      property: 'Issue',
      url: {
        equals: payload.issue.html_url,
      },
    },
    page_size: 1,
  });

  const bodyBlocks = getBodyChildrenBlocks(payload.issue.body);

  if (query.results.length > 0) {
    const pageId = query.results[0].id;

    core.info(`Query successful: Page ${pageId}`);
    core.info(`Updating page for issue #${payload.issue.html_url}`);

    const notionRelations = await getNotionRelations(notion.client);

    await notion.client.pages.update({
      page_id: pageId,
      properties: await parsePropertiesFromPayload({
        payload,
        userRelations: notionRelations.users,
        notionProjects: notionRelations.projects
      }),
    });

    const existingBlocks = (
      await notion.client.blocks.children.list({
        block_id: pageId,
      })
    ).results;

    const overlap = Math.min(bodyBlocks.length, existingBlocks.length);

    await Promise.all(
      bodyBlocks.slice(0, overlap).map((block, index) =>
        notion.client.blocks.update({
          block_id: existingBlocks[index].id,
          ...block,
        })
      )
    );

    if (bodyBlocks.length > existingBlocks.length) {
      await notion.client.blocks.children.append({
        block_id: pageId,
        children: bodyBlocks.slice(overlap),
      });
    } else if (bodyBlocks.length < existingBlocks.length) {
      await Promise.all(
        existingBlocks
          .slice(overlap)
          .map(block => notion.client.blocks.delete({ block_id: block.id }))
      );
    }
  } else {
    core.warning(`Could not find task for github issue ${payload.issue.html_url}, creating a new one`);

    const notionRelations = await getNotionRelations(notion.client);

    await notion.client.pages.create({
      parent: {
        database_id: notion.databaseId,
      },
      properties: await parsePropertiesFromPayload({
        payload,
        userRelations: notionRelations.users,
        notionProjects: notionRelations.projects
      }),
      children: bodyBlocks,
    });
  }
}

interface Options {
  notion: {
    token: string;
    databaseId: string;
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
        databaseId: notion.databaseId,
      },
      payload: github.payload as IssuesOpenedEvent,
    });
  } else if (github.eventName === 'workflow_dispatch') {
    core.info('Handling workflow_dispatch event');

    const notion = new Client({ auth: options.notion.token });
    const { databaseId } = options.notion;
    const issuePageIds = await createIssueMapping(notion, databaseId);

    if (!github.payload.repository?.full_name) {
      throw new Error('Unable to find repository name in github webhook context');
    }

    const githubRepo = github.payload.repository.full_name;
    await syncNotionDBWithGitHub(issuePageIds, notion, databaseId, githubRepo);
  } else {
    await handleIssueEdited({
      notion: {
        client: notionClient,
        databaseId: notion.databaseId,
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
  notionClient: Client
): Promise<NotionProjectInfo[]> {
  const databaseId = 'bd9cfdc0d0234340b79a3fea75f48468'; // Replace with your actual database ID
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
