import { Client } from '@notionhq/client/build/src';
import * as core from '@actions/core';
import { CustomValueMap, notionFields, properties } from './properties';
import { getNotionRelations, getProject, graphqlWithAuth, NotionRelationsInterface, ProjectData } from './action';
import { PageObjectResponse, QueryDatabaseResponse } from '@notionhq/client/build/src/api-endpoints';

export async function syncGithubIssuesWithNotionTasks(
  notionClient: Client,
  notionTaskDatabaseId: string,
  notionProjectDatabaseId: string,
  notionUsersDatabaseId: string,
  githubRepo: string
) {
  const issues = await getGitHubIssues(githubRepo);
  const issuePages = await getIssuePagesAlreadyInNotion(notionClient, notionTaskDatabaseId);

  await createOrUpdateTasksInNotion(
    notionClient,
    notionTaskDatabaseId,
    notionProjectDatabaseId,
    notionUsersDatabaseId,
    issues,
    issuePages
  );
}

async function createOrUpdateTasksInNotion(
  notionClient: Client,
  notionTaskDatabaseId: string,
  notionProjectDatabaseId: string,
  notionUsersDatabaseId: string,
  issues: GitHubIssue[],
  issuePages: PageObjectResponse[]
): Promise<void> {
  const taskIssueUrls = getTaskIssueUrls(issuePages);

  const notionRelations = await getNotionRelations({
    client: notionClient,
    taskDatabaseId: notionTaskDatabaseId,
    projectDatabaseId: notionProjectDatabaseId,
    usersDatabaseId: notionUsersDatabaseId
  });

  for (const issue of issues) {
    const issueUrl = issue.html_url;

    const pageToCreateOrUpdate = {
      parent: { database_id: notionTaskDatabaseId },
      properties: await getPropertiesFromIssueOrGithubProject(issue, notionRelations)
    };

    console.log(`Page to create or update for issue ${issueUrl}:`, JSON.stringify(pageToCreateOrUpdate));

    if (taskIssueUrls.includes(issueUrl)) {
      core.info(`Issue ${issueUrl} already exists in Notion. Updating task...`);

      const needsUpdate = needsNotionPageUpdate(
        issuePages[taskIssueUrls.indexOf(issueUrl)],
        pageToCreateOrUpdate.properties
      );

      if (!needsUpdate) {
        core.info(`No update needed for issue ${issueUrl}`);
        continue;
      }

      const updatedPage = await notionClient.pages.update({
        page_id: issuePages[taskIssueUrls.indexOf(issueUrl)].id,
        properties: pageToCreateOrUpdate.properties
      });

      core.info(`Updated task for issue ${issue.html_url} with ID ${updatedPage.id}`);
    } else if (issue.state !== 'CLOSED') {
      core.info(`Creating task for issue ${issueUrl}`);

      const createdPage = await notionClient.pages.create(pageToCreateOrUpdate);

      core.info(`Created task for issue ${issue.html_url} with ID ${createdPage.id}`);
    } else {
      core.info(`Skipping closed issue ${issueUrl}`);
    }
  }
}

/**
 * Extracts the GitHub issue URLs from an array of Notion page objects.
 *
 * Iterates over the provided `issuePages` and retrieves the value of the
 * `GithubIssue` property (assumed to be a URL) from each page. If the property
 * exists and is of type 'url', its value is returned; otherwise, an empty string
 * is returned for that page.
 *
 * @param issuePages - An array of Notion `PageObjectResponse` objects to extract URLs from.
 * @returns An array of strings containing the GitHub issue URLs (or empty strings if not present).
 */
function getTaskIssueUrls(issuePages: PageObjectResponse[]): string[] {
  return issuePages.map(page => {
    const prop = page.properties[notionFields.GithubIssue];
    return prop && prop.type === 'url' ? prop.url || '' : '';
  });
};

/**
 * Retrieves all Notion pages from the specified database that have a non-empty GitHub Issue URL property.
 *
 * Iterates through the entire database using pagination, collecting all pages where the `GithubIssue` property
 * contains a URL. This is useful for identifying which GitHub issues are already present in the Notion database.
 *
 * @param notion - The Notion API client instance.
 * @param databaseId - The ID of the Notion database to query.
 * @returns A promise that resolves to an array of `PageObjectResponse` objects representing the matching Notion pages.
 */
async function getIssuePagesAlreadyInNotion(
  notion: Client,
  databaseId: string
): Promise<PageObjectResponse[]> {
  core.info('Checking for issues already in the database...');

  const pages: PageObjectResponse[] = [];
  let cursor = undefined;
  let next_cursor: string | null = 'true';
  while (next_cursor) {
    const response: QueryDatabaseResponse = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      filter: {
        property: notionFields.GithubIssue,
        url: {
          is_not_empty: true
        }
      }
    });
    next_cursor = response.next_cursor;
    const results = response.results.filter(
      (page): page is PageObjectResponse => page.object === 'page'
    );

    pages.push(...results);

    if (!next_cursor) {
      break;
    }
    cursor = next_cursor;
  }

  return pages;
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

async function getGitHubIssues(githubRepo: string): Promise<GitHubIssue[]> {
  core.info('Finding Github Issues...');

  const [owner, repo] = githubRepo.split('/');
  let issues: GitHubIssue[] = [];
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

    // Filter out issues where issueType.name === 'Feature'
    issuesResponse.repository.issues.nodes = issuesResponse.repository.issues.nodes.filter(
      issue => !(issue.issueType && issue.issueType.name === 'Feature')
    );

    const pageIssues = issuesResponse.repository.issues.nodes;
    issues.push(...pageIssues);

    hasNextPage = issuesResponse.repository.issues.pageInfo.hasNextPage;
    cursor = issuesResponse.repository.issues.pageInfo.endCursor;
  }

  return issues;
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

  const valueMap: CustomValueMap = {
    [notionFields.Name]: properties.title(issue.title),
    [notionFields.Description]: properties.text(issue.body ?? ''),
    [notionFields.Status]: properties.status(getNotionStatusFromGithubIssue(issue, project)),
    [notionFields.Repository]: properties.text(repo),
    [notionFields.Assignee]: properties.person(issue.assignees.nodes.map(assignee => assignee.login), notionRelations.users),
    [notionFields.GithubIssue]: properties.url(issue.html_url),
    [notionFields.Project]: properties.relation(project?.customFields?.['Project KEY'] as string, notionRelations.projects),
    [notionFields.TaskGroup]: properties.text("Development")
  };

  if (project?.customFields?.['Estimate']) {
    valueMap[notionFields.EstimateHrs] = properties.number(project.customFields['Estimate'] as number);
  };

  return valueMap;
}

/**
 * Extracts a comparable string value from a Notion property object (either from PageObjectResponse or CustomValueMap).
 */
function extractComparableValue(prop: any): string {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
      // Notion API response: plain_text; update: text.content
      if (Array.isArray(prop.title) && prop.title.length > 0) {
        // Prefer plain_text if present, else fallback to text.content
        return prop.title.map((t: any) => t.plain_text ?? t.text?.content ?? '').join(' ');
      }
      return '';
    case 'rich_text':
      if (Array.isArray(prop.rich_text) && prop.rich_text.length > 0) {
        return prop.rich_text.map((t: any) => t.plain_text ?? t.text?.content ?? '').join(' ');
      }
      return '';
    case 'select':
      return prop.select?.name || '';
    case 'multi_select':
      return Array.isArray(prop.multi_select)
        ? prop.multi_select.map((opt: any) => opt.name).sort().join(',')
        : '';
    case 'status':
      return prop.status?.name || '';
    case 'number':
      return typeof prop.number === 'number' ? String(prop.number) : '';
    case 'url':
      return prop.url || '';
    case 'relation':
      return Array.isArray(prop.relation)
        ? prop.relation.map((r: any) => r.id).sort().join(',')
        : '';
    case 'people':
      return Array.isArray(prop.people)
        ? prop.people.map((p: any) => p.id).sort().join(',')
        : '';
    case 'date':
      return prop.date?.start || '';
    case 'checkbox':
      return String(prop.checkbox);
    case 'email':
      return prop.email || '';
    case 'phone_number':
      return prop.phone_number || '';
    default:
      return '';
  }
}

/**
 * Compares the properties of an existing Notion page with new properties to determine if an update is needed.
 * @param existingPage The Notion PageObjectResponse (existing page).
 * @param newProperties The new properties object (from getPropertiesFromIssueOrGithubProject).
 * @returns true if the page needs to be updated, false otherwise.
 */
export function needsNotionPageUpdate(
  existingPage: PageObjectResponse,
  newProperties: CustomValueMap
): boolean {
  for (const key of Object.keys(newProperties)) {
    const newProp = newProperties[key];
    const existingProp = existingPage.properties[key];

    // If property is missing, or values differ, update is needed
    if (!existingProp || !newProp) return true;

    const newValue = extractComparableValue(newProp);
    const existingValue = extractComparableValue(existingProp);

    if (newValue !== existingValue) return true;
  }
  return false;
}
