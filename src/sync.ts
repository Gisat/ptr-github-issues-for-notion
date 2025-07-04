import { Client } from '@notionhq/client/build/src';
import * as core from '@actions/core';
import { CustomValueMap, notionFields, properties } from './properties';
import { getNotionRelations, getProject, graphqlWithAuth, NotionRelationsInterface, ProjectData } from './action';
import { QueryDatabaseResponse } from '@notionhq/client/build/src/api-endpoints';
import { CustomTypes } from './api-types';

type PageIdAndIssueUrl = {
  pageId: string;
  issueUrl: string;
};

export async function createIssueMapping(
  notion: Client,
  notionTaskDatabaseId: string
): Promise<Map<string, string>> {
  const issuePageIds = new Map<string, string>();
  const issuesAlreadyInNotion: {
    pageId: string;
    issueUrl: string
  }[] = await getIssuesAlreadyInNotion(notion, notionTaskDatabaseId);

  for (const { pageId, issueUrl } of issuesAlreadyInNotion) {
    core.info(`Mapping issue ${issueUrl} to page ID ${pageId}`);
    issuePageIds.set(issueUrl, pageId);
  }

  return issuePageIds;
}

export async function syncNotionDBWithGitHub(
  issuePageIds: Map<string, string>,
  notionClient: Client,
  notionTaskDatabaseId: string,
  notionProjectDatabaseId: string,
  notionUsersDatabaseId: string,
  githubRepo: string
) {
  const issues = await getGitHubIssues(githubRepo);

  const issuesNotInNotion = getIssuesNotInNotion(issuePageIds, issues);

  await createTasks({
    notionClient,
    notionTaskDatabaseId,
    notionProjectDatabaseId,
    notionUsersDatabaseId,
    issuesNotInNotion
  });
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
      const issueProp = page.properties[notionFields.GithubIssue] as CustomTypes.URL | undefined;
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
  issueType?: { name: string };
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
        issues(first: 100, after: $cursor) {
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
          issueType {
          name
          }
          state
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

interface CreateTasksInterface {
  notionClient: Client;
  notionTaskDatabaseId: string;
  notionProjectDatabaseId: string;
  notionUsersDatabaseId: string;
  issuesNotInNotion: GitHubIssue[];
}

// Notion SDK for JS: https://developers.notion.com/reference/post-page
async function createTasks(
  options: CreateTasksInterface
): Promise<void> {
  core.info('Adding Github Issues to Notion...');

  const notionRelations = await getNotionRelations({
    client: options.notionClient,
    taskDatabaseId: options.notionTaskDatabaseId,
    projectDatabaseId: options.notionProjectDatabaseId,
    usersDatabaseId: options.notionUsersDatabaseId
  });

  for (const issue of options.issuesNotInNotion) {
    if (issue.issueType && issue.issueType.name === 'Feature') {
      core.info(`Skipping issue #${issue.html_url} because its issueType is 'Feature'`);
      continue;
    }

    const pageToCreate = {
      parent: { database_id: options.notionTaskDatabaseId },
      properties: await getPropertiesFromIssueOrGithubProject(issue, notionRelations)
    };

    core.info(`Creating task for issue #${issue.html_url}`);

    const createdPage = await options.notionClient.pages.create(pageToCreate);

    core.info(`Created task for issue #${issue.html_url} with ID ${createdPage.id}`);
  }
}

// Returns single notion status based on GitHub issue state, Github issue labels and project custom field "Status"
function getNotionStatusFromGithubIssue(issue: GitHubIssue, GithubProject?: ProjectData): string | null {
  if (issue.state === "CLOSED") {
    return "Done";
  }

  // Check if the issue has a label that indicates it's blocked
  if (issue.labels.nodes.some(label => label.name.toLowerCase() === 'blocked')) {
    return "Blocked";
  }

  // Check if issue has a lablel tha indicates it's duplicated
  if (issue.labels.nodes.some(label => label.name.toLowerCase() === 'duplicate')) {
    return "Duplicate";
  }

  if (GithubProject?.customFields?.['Status']) {
    return GithubProject.customFields['Status'] as string;
  }

  return null
}

async function getPropertiesFromIssueOrGithubProject(issue: GitHubIssue, notionRelations: NotionRelationsInterface): Promise<CustomValueMap> {
  const reporistoryFullName = issue.repository.url.split('/').slice(-2).join('/');
  const org = reporistoryFullName.split('/')[0];
  const repo = reporistoryFullName.split('/')[1];

  const project = await getProject({
    githubRepo: `${org}/${repo}`,
    issueNumber: issue.number,
  });

  const issueProperties: CustomValueMap = {
    [notionFields.Name]: properties.title(issue.title),
    [notionFields.Description]: properties.text(issue.body ?? ''),
    [notionFields.Status]: properties.status(getNotionStatusFromGithubIssue(issue, project)),
    [notionFields.Repository]: properties.text(repo),
    [notionFields.Assignee]: properties.person(issue.assignees.nodes.map(assignee => assignee.login), notionRelations.users),
    [notionFields.GithubIssue]: properties.url(issue.html_url),
    [notionFields.Project]: properties.relation(project?.customFields?.['Project KEY'] as string, notionRelations.projects),
    [notionFields.TaskGroup]: properties.text("Development")
  }

  console.log(`Project: ${JSON.stringify(project)}`);

  if (project?.customFields?.['Estimate']) {
    issueProperties[notionFields.EstimateHrs] = properties.number(project.customFields['Estimate'] as number);
  };

  return issueProperties;
}
