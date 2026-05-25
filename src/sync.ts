import { Client } from '@notionhq/client';
import * as core from '@actions/core';
import { CustomValueMap, notionFields, notionFieldsToUpdate, properties } from './properties';
import { getNotionRelations, getGithubOgranizationProjects, graphqlWithAuth, NotionRelationsInterface, ProjectData } from './action';
import { PageObjectResponse, QueryDataSourceResponse, BlockObjectRequest } from '@notionhq/client';
import { markdownToBlocks } from '@tryfabric/martian';
import { withRetry } from './retry';

export async function syncGithubIssuesWithNotionTasks(
  notionClient: Client,
  notionTaskDataSourceId: string,
  notionProjectDataSourceId: string,
  notionUsersDataSourceId: string,
  githubRepo: string
) {
  const issues = await getGithubRepositoryIssues(githubRepo);
  const projects = await getGithubOgranizationProjects(githubRepo.split('/')[0]);
  const issuePages = await getIssuePagesAlreadyInNotion(notionClient, notionTaskDataSourceId);

  await createOrUpdateTasksInNotion(
    notionClient,
    notionTaskDataSourceId,
    notionProjectDataSourceId,
    notionUsersDataSourceId,
    issues,
    projects,
    issuePages
  );
}

async function createOrUpdateTasksInNotion(
  notionClient: Client,
  notionTaskDataSourceId: string,
  notionProjectDataSourceId: string,
  notionUsersDataSourceId: string,
  issues: GitHubIssue[],
  projects: ProjectData[],
  issuePages: PageObjectResponse[]
): Promise<void> {
  const taskIssueUrls = getTaskIssueUrls(issuePages);

  const notionRelations = await withRetry(() => getNotionRelations({
    client: notionClient,
    taskDataSourceId: notionTaskDataSourceId,
    projectDataSourceId: notionProjectDataSourceId,
    usersDataSourceId: notionUsersDataSourceId
    }));

  for (const issue of issues) {
    try {
      const issueUrl = issue.html_url;

      const issueRelatedProjects = projects.filter(project => project.issues.some(issueData => issueData.id === issue.id));

      if (issueRelatedProjects.length === 0) {
        core.info(`No related projects found for issue ${issueUrl}. Skipping...`);
        continue;
      }

      if (!issue.assignees || !issue.assignees.nodes || issue.assignees.nodes.length === 0) {
        core.info(`Issue ${issueUrl} has no assignees. Skipping...`);
        continue;
      }

      const githubAssignees = issue.assignees.nodes.map(a => a.login);
      const missingAssignees = githubAssignees.filter(
        login => !notionRelations.users.some(user => user.githubUsername === login)
      );

      if (missingAssignees.length > 0) {
        core.info(
          `Skipping issue ${issueUrl} because the following assignees are missing in Notion users: ${missingAssignees.join(', ')}`
        );
        continue;
      }

      if (taskIssueUrls.includes(issueUrl)) {
        const pageToUpdate = issuePages[taskIssueUrls.indexOf(issueUrl)];
        const newProperties = await getPropertiesFromIssueOrGithubProject(issue, issueRelatedProjects, notionRelations);

        let needsUpdate = false;
        for (const key of notionFieldsToUpdate) {
          const newProp = newProperties[key];
          const existingProp = pageToUpdate.properties[key];
          if (!existingProp || !newProp) {
            needsUpdate = true;
            break;
          }
          const newValue = extractComparableValue(newProp);
          const existingValue = extractComparableValue(existingProp);
          if (newValue !== existingValue) {
            needsUpdate = true;
            break;
          }
        }

        if (!needsUpdate) {
          core.info(`No update needed for issue ${issueUrl}`);
          continue;
        }

        const updatedPage = await withRetry(() => notionClient.pages.update({
          page_id: pageToUpdate.id,
          properties: Object.fromEntries(
            Object.entries(newProperties).filter(([key]) => notionFieldsToUpdate.includes(key))
          ),
        }));

        core.info(`Updated task for issue ${issue.html_url} with ID ${updatedPage.id}`);
      } else if (issue.state !== 'CLOSED' && (issue.issueType && issue.issueType.name !== "Feature")) {
        const newProperties = await getPropertiesFromIssueOrGithubProject(issue, issueRelatedProjects, notionRelations);
        const createdPage = await withRetry(() => notionClient.pages.create({
          parent: { data_source_id: notionTaskDataSourceId },
          properties: newProperties,
          children: issue.body
            ? markdownToBlocks(issue.body) as BlockObjectRequest[]
            : [],
        }));

        core.info(`Created task for issue ${issue.html_url} with ID ${createdPage.id}`);
      } else {
        core.info(`Skipping issue ${issueUrl} because it is closed or a feature request.`);
      }
    } catch (e) {
      core.warn(`Failed to process issue ${issue.html_url}: ${e instanceof Error ? e.message : e}. Continuing...`);
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
 * Retrieves all Notion pages from the specified data source that have a non-empty GitHub Issue URL property.
 *
 * Iterates through the entire data source using pagination, collecting all pages where the `GithubIssue` property
 * contains a URL. This is useful for identifying which GitHub issues are already present in the Notion data source.
 *
 * @param notion - The Notion API client instance.
 * @param dataSourceId - The ID of the Notion data source to query.
 * @returns A promise resolving to an array of `PageObjectResponse` objects representing the matching Notion pages.
 */
async function getIssuePagesAlreadyInNotion(
  notion: Client,
  dataSourceId: string
): Promise<PageObjectResponse[]> {
  core.info('Checking for issues already in the data source...');

  const pages: PageObjectResponse[] = [];
  let cursor = undefined;
  let next_cursor: string | null = 'true';
  while (next_cursor) {
    const response: QueryDataSourceResponse = await withRetry(() => notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      page_size: 50,
      filter: {
        property: notionFields.GithubIssue,
        url: { is_not_empty: true }
      }
    }));
    next_cursor = response.next_cursor;
    const results = response.results.filter(
      (page): page is PageObjectResponse => page.object === 'page'
    );
    pages.push(...results);
    if (!next_cursor) break;
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

async function getGithubRepositoryIssues(githubRepo: string): Promise<GitHubIssue[]> {
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

    const pageIssues = issuesResponse.repository.issues.nodes;
    issues.push(...pageIssues);

    hasNextPage = issuesResponse.repository.issues.pageInfo.hasNextPage;
    cursor = issuesResponse.repository.issues.pageInfo.endCursor;
  }

  return issues;
}


function getNotionTaskTypeFromGithubIssue(issue: GitHubIssue): string {
  if (issue.labels.nodes.some(label => label.name.toLowerCase() === 'Research')) {
    return 'Research';
  }

  if (issue.labels.nodes.some(label => label.name.toLowerCase() === 'Maintenance')) {
    return 'Maintenance';
  }

  return "Dev | Apps"
}

// Returns single notion status based on GitHub issue state, Github issue labels and project custom field "Status"
function getNotionStatusFromGithubIssue(issue: GitHubIssue, projectStates?: string[]): string | null {
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

  if (projectStates && projectStates.includes("In review")) {
    return "In review";
  }

  if (projectStates && projectStates.includes("In progress")) {
    return "In progress";
  }

  return null
}

interface issueDataPerProject {
  notionId: string;
  state: string;
  estimate: number;
}

async function getPropertiesFromIssueOrGithubProject(issue: GitHubIssue, projects: ProjectData[], notionRelations: NotionRelationsInterface): Promise<CustomValueMap> {
  const issueDataPerProject: issueDataPerProject[] = [];

  let taskGroupNameFromProjectName: string | undefined;

  for (const project of projects) {
    const projectIssue = project.issues.find(issueData => issueData.id === issue.id);
    if (projectIssue) {
      const projectIssueState = projectIssue.customFields['Status'] as string;
      const projectIssueEstimate = projectIssue.customFields?.['Estimate'] as number;

      if (!taskGroupNameFromProjectName) {
        taskGroupNameFromProjectName = project.name;
      }

      issueDataPerProject.push({
        notionId: project.notionId,
        state: projectIssueState,
        estimate: projectIssueEstimate
      });
    }
  }

  const issueStatesFromProjects: string[] = issueDataPerProject.map(data => data.state);

  const valueMap: CustomValueMap = {
    [notionFields.Name]: properties.title(issue.title),
    [notionFields.Status]: properties.status(getNotionStatusFromGithubIssue(issue, issueStatesFromProjects)),
    [notionFields.Assignee]: properties.person(issue.assignees.nodes.map(assignee => assignee.login), notionRelations.users),
    [notionFields.GithubIssue]: properties.url(issue.html_url),
    [notionFields.Project]: properties.relation(projects, notionRelations.projects),
    [notionFields.TaskGroup]: properties.text(taskGroupNameFromProjectName || ''),
    [notionFields.TaskType]: properties.multiSelect([getNotionTaskTypeFromGithubIssue(issue)])
  };

  // Find the maximum estimate from issueDataPerProject
  const maxEstimate = issueDataPerProject.reduce((max, data) => {
    if (typeof data.estimate === 'number' && !isNaN(data.estimate)) {
      return Math.max(max, data.estimate);
    }
    return max;
  }, 0);

  // Only set the estimate if at least one project has an estimate
  if (maxEstimate > 0) {
    valueMap[notionFields.EstimateHrs] = properties.number(maxEstimate);
  }

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
