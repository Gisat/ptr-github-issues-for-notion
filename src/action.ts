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
  notionId: string;
  issues: Array<{
    issueNumber: number;
    id: string; // Unique identifier for the issue
    state: string;
    customFields: Record<string, string | number | null>;
  }>;
}

export async function getGithubOgranizationProjects(org: string): Promise<ProjectData[] | []> {
  core.info(`Fetching all active projectsV2 in organization ${org}`);

  let queryProjects: any[] = [];
  let hasNextPage = true;
  let endCursor: string | null = null;

  while (hasNextPage) {
    // Fetch a page of organization projectsV2
    const projectsResponse = await graphqlWithAuth(
      `
      query($org: String!, $after: String) {
        organization(login: $org) {
          projectsV2(first: 20, after: $after) {
            nodes {
              id
              number
              title
              shortDescription
              url
              closed
              fields(first: 100) {
                nodes {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                    dataType
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
              items(first: 100) {
                nodes {
                  id
                  content {
                    ... on Issue {
                      issueNumber: number
                      id
                      state
                    }
                  }
                  fieldValues(first: 100) {
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
                    pageInfo { hasNextPage endCursor }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      `,
      {
        org,
        after: endCursor,
      }
    ) as {
      organization: {
        projectsV2: {
          nodes: Array<any>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };

    // Nested pagination for fields, items, and fieldValues
    for (const project of projectsResponse.organization.projectsV2.nodes) {
      if (project.closed) continue; // Only active projects

      // Paginate fields
      let fields = project.fields.nodes;
      let fieldsPageInfo = project.fields.pageInfo;
      while (fieldsPageInfo.hasNextPage) {
        const fieldsResponse = await graphqlWithAuth(
          `
          query($projectId: ID!, $after: String) {
            node(id: $projectId) {
              ... on ProjectV2 {
                fields(first: 100, after: $after) {
                  nodes {
                    ... on ProjectV2FieldCommon {
                      id
                      name
                      dataType
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
          `,
          {
            projectId: project.id,
            after: fieldsPageInfo.endCursor,
          }
        ) as any;
        fields = fields.concat(fieldsResponse.node.fields.nodes);
        fieldsPageInfo = fieldsResponse.node.fields.pageInfo;
      }
      project.fields.nodes = fields;

      // Paginate items
      let items = project.items.nodes;
      let itemsPageInfo = project.items.pageInfo;
      while (itemsPageInfo.hasNextPage) {
        const itemsResponse = await graphqlWithAuth(
          `
          query($projectId: ID!, $after: String) {
            node(id: $projectId) {
              ... on ProjectV2 {
                items(first: 100, after: $after) {
                  nodes {
                    id
                    content {
                      ... on Issue {
                        issueNumber: number
                        id
                        state
                      }
                    }
                    fieldValues(first: 100) {
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
                      pageInfo { hasNextPage endCursor }
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
          `,
          {
            projectId: project.id,
            after: itemsPageInfo.endCursor,
          }
        ) as any;
        items = items.concat(itemsResponse.node.items.nodes);
        itemsPageInfo = itemsResponse.node.items.pageInfo;
      }
      project.items.nodes = items;

      // Paginate fieldValues for each item
      for (const item of project.items.nodes) {
        let fieldValues = item.fieldValues.nodes;
        let fieldValuesPageInfo = item.fieldValues.pageInfo;
        while (fieldValuesPageInfo.hasNextPage) {
          const fieldValuesResponse = await graphqlWithAuth(
            `
            query($itemId: ID!, $after: String) {
              node(id: $itemId) {
                ... on ProjectV2Item {
                  fieldValues(first: 100, after: $after) {
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
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }
            }
            `,
            {
              itemId: item.id,
              after: fieldValuesPageInfo.endCursor,
            }
          ) as any;
          fieldValues = fieldValues.concat(fieldValuesResponse.node.fieldValues.nodes);
          fieldValuesPageInfo = fieldValuesResponse.node.fieldValues.pageInfo;
        }
        item.fieldValues.nodes = fieldValues;
      }

      queryProjects.push(project);
    }

    hasNextPage = projectsResponse.organization.projectsV2.pageInfo.hasNextPage;
    endCursor = projectsResponse.organization.projectsV2.pageInfo.endCursor;
  }

  core.info(`Found ${queryProjects.length} active projectsV2 in the organization.`);
  queryProjects.sort((a, b) => a.number - b.number);

  const projectsData: ProjectData[] = [];

  for (const project of queryProjects) {
    // Extract notionId from project.shortDescription, e.g., "|GST-12|"
    let notionId = '';
    const match = project.shortDescription?.match(/\|([A-Z]+-\d+)\|/);
    if (match) {
      notionId = match[1];
    }

    projectsData.push({
      name: project.title,
      url: project.url,
      notionId,
      issues: project.items.nodes.map((item: any) => {
        const customFields: Record<string, string | number | null> = {};
        item.fieldValues.nodes.forEach((fieldValue: any) => {
          if (fieldValue.field && fieldValue.field.name) {
            if (fieldValue.name !== undefined) {
              customFields[fieldValue.field.name] = fieldValue.name;
            } else if (fieldValue.text !== undefined) {
              customFields[fieldValue.field.name] = fieldValue.text;
            } else if (fieldValue.number !== undefined) {
              customFields[fieldValue.field.name] = fieldValue.number;
            }
          }
        });
        return {
          issueNumber: item.content?.issueNumber ?? 0,
          id: item.content?.id ?? item.id, // Return unique id for the issue (prefer issue id, fallback to item id)
          state: item.content?.state ?? 'UNKNOWN',
          customFields
        };
      })
    });
  }

  return projectsData;
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
  notionId: string;
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
        result.properties['ID'] &&
        result.properties['ID'].type === 'unique_id' &&
        result.properties['ID'].unique_id &&
        result.properties['ID'].unique_id.number &&
        result.properties['ID'].unique_id.prefix
      ) {
        projects.push({
          id: result.id,
          notionId: `${result.properties['ID'].unique_id.prefix}-${result.properties['ID'].unique_id.number}`
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
