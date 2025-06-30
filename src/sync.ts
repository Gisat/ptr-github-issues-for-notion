import { Client } from '@notionhq/client/build/src';
import * as core from '@actions/core';
import { CustomValueMap, properties } from './properties';
import { getBodyChildrenBlocks, getNotionRelations, getProject, graphqlWithAuth, NotionRelationsInterface } from './action';
import { QueryDatabaseResponse } from '@notionhq/client/build/src/api-endpoints';
import { CustomTypes } from './api-types';

type PageIdAndIssueUrl = {
  pageId: string;
  issueUrl: string;
};

export async function createIssueMapping(
  notion: Client,
  databaseId: string
): Promise<Map<string, string>> {
  const issuePageIds = new Map<string, string>();
  const issuesAlreadyInNotion: {
    pageId: string;
    issueUrl: string
  }[] = await getIssuesAlreadyInNotion(notion, databaseId);

  for (const { pageId, issueUrl } of issuesAlreadyInNotion) {
    core.info(`Mapping issue ${issueUrl} to page ID ${pageId}`);
    issuePageIds.set(issueUrl, pageId);
  }

  return issuePageIds;
}

export async function syncNotionDBWithGitHub(
  issuePageIds: Map<string, string>,
  notion: Client,
  databaseId: string,
  githubRepo: string
) {
  const issues = await getGitHubIssues(githubRepo);

  const issuesNotInNotion = getIssuesNotInNotion(issuePageIds, issues);

  await createTasks(notion, databaseId, issuesNotInNotion);
}

// Notion SDK for JS: https://developers.notion.com/reference/post-database-query
async function getIssuesAlreadyInNotion(
  notion: Client,
  databaseId: string
): Promise<PageIdAndIssueUrl[]> {
  core.info('Checking for issues already in the database...');

  const pages: QueryDatabaseResponse['results'] = [];
  let cursor = undefined;
  let next_cursor: string | null = 'true';
  while (next_cursor) {
    const response: QueryDatabaseResponse = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });
    next_cursor = response.next_cursor;
    const results = response.results;
    pages.push(...results);
    if (!next_cursor) {
      break;
    }
    cursor = next_cursor;
  }

  const pageIdAndIssueUrlList: PageIdAndIssueUrl[] = [];

  pages.forEach(page => {
    if ('properties' in page) {
      const issueProp = page.properties['Issue'] as CustomTypes.URL | undefined;
      const issueUrl = issueProp && 'url' in issueProp ? issueProp.url : null;
      if (typeof issueUrl === 'string' && issueUrl)
        pageIdAndIssueUrlList.push({
          pageId: page.id,
          issueUrl
        });
    }
  });

  return pageIdAndIssueUrlList;
}

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  id: string;
  milestone: { title: string } | null;
  createdAt: string;
  updatedAt: string;
  body: string | null;
  repository: { url: string };
  user: { login: string };
  html_url: string;
  assignees: { nodes: { login: string }[] };
  labels: { nodes: { name: string }[] };
}

interface IssuesResponse {
  repository: {
    issues: {
      pageInfo: { endCursor: string; hasNextPage: boolean };
      nodes: GitHubIssue[];
    };
  };
}

async function getGitHubIssues(githubRepo: string) {
  core.info('Finding Github Issues...');

  const [owner, repo] = githubRepo.split('/');
  let issues: any[] = [];
  let hasNextPage = true;
  let cursor: string | undefined = undefined;

  while (hasNextPage) {
    const issuesResponse = await graphqlWithAuth(
      `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          issues(first: 100, after: $cursor, states: OPEN) {
            pageInfo {
              endCursor
              hasNextPage
            }
            nodes {
              number
              title
              state
              id
              milestone { title }
              createdAt
              updatedAt
              body
              repository { url }
              user: author { login }
              html_url: url
              assignees(first: 30) {
                nodes { login }
              }
              labels(first: 30) {
                nodes { name }
              }
            }
          }
        }
      }
      `,
      { owner, repo, cursor }
    ) as IssuesResponse;

    const pageIssues = issuesResponse.repository.issues.nodes;
    issues.push(...pageIssues);

    hasNextPage = issuesResponse.repository.issues.pageInfo.hasNextPage;
    cursor = issuesResponse.repository.issues.pageInfo.endCursor;
  }

  return issues;
}

function getIssuesNotInNotion(issuePageIds: Map<string, string>, issues: GitHubIssue[]): GitHubIssue[] {
  const issuesNotInNotion = [];
  for (const issue of issues) {
    if (!issuePageIds.has(issue.html_url)) {
      issuesNotInNotion.push(issue);
    }
  }
  return issuesNotInNotion;
}

// Notion SDK for JS: https://developers.notion.com/reference/post-page
async function createTasks(
  notion: Client,
  databaseId: string,
  issuesNotInNotion: GitHubIssue[]
): Promise<void> {
  core.info('Adding Github Issues to Notion...');

  const notionRelations = await getNotionRelations(notion);

  for (const issue of issuesNotInNotion) {
    const pageToCreate = {
      parent: { database_id: databaseId },
      properties: await getPropertiesFromIssue(issue, notionRelations)
    };

    core.info(`Creating task for issue #${issue.html_url}`);

    // Create the page without children
    const createdPage = await notion.pages.create(pageToCreate);

    core.info(`Created task for issue #${issue.html_url} with ID ${createdPage.id}`);

    // Append children (body blocks) if any
    // const children = getBodyChildrenBlocks(issue.body ?? '');
    // if (children && children.length > 0) {
    //   await notion.blocks.children.append({
    //     block_id: createdPage.id,
    //     children
    //   });
    // }
  }
}

async function getPropertiesFromIssue(issue: GitHubIssue, notionRelations: NotionRelationsInterface): Promise<CustomValueMap> {
  const reporistoryFullName = issue.repository.url.split('/').slice(-2).join('/');
  const org = reporistoryFullName.split('/')[0];
  const repo = reporistoryFullName.split('/')[1];

  const project = await getProject({
    githubRepo: `${org}/${repo}`,
    issueNumber: issue.number,
  });

  const issueProperties: CustomValueMap = {
    Name: properties.title(issue.title),
    Status: properties.status(project?.customFields?.['Status'] as string),
    Repository: properties.text(repo),
    Assignee: properties.person(issue.assignees.nodes.map(assignee => assignee.login), notionRelations.users),
    Labels: properties.multiSelect(issue.labels.nodes.map(label => label.name) ?? []),
    Issue: properties.url(issue.html_url),
    Project: properties.relation(project?.customFields?.['Project KEY'] as string, notionRelations.projects),
    'Task group': properties.text("Development")
  }

  return issueProperties;
}
