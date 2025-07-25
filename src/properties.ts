import { NotionProjectInfo, userRelationGithubNotionType } from './action';
import { CustomTypes, SelectColor } from './api-types';
import { common } from './common';

export type CustomValueMap = {
  Name: CustomTypes.Title;
  Status: CustomTypes.Status;
  Repository: CustomTypes.RichText;
  Assignee: CustomTypes.People;
  Labels: CustomTypes.MultiSelect;
  Issue: CustomTypes.URL;
  Project: CustomTypes.Relation;
  'Task group': CustomTypes.RichText;
};

export namespace properties {
  export function text(text: string): CustomTypes.RichText {
    return {
      type: 'rich_text',
      rich_text: text ? common.richText(text) : [],
    };
  }

  export function richText(text: CustomTypes.RichText['rich_text']): CustomTypes.RichText {
    return {
      type: 'rich_text',
      rich_text: text,
    };
  }

  export function title(text: string): CustomTypes.Title {
    return {
      type: 'title',
      title: [
        {
          type: 'text',
          text: {
            content: text,
          },
        },
      ],
    };
  }

  export function number(number: number): CustomTypes.Number {
    return {
      type: 'number',
      number: number,
    };
  }

  export function date(time: string): CustomTypes.Date {
    return {
      type: 'date',
      date: {
        start: time,
      },
    };
  }

  export function getStatusSelectOption(state: 'open' | 'closed'): CustomTypes.Select {
    switch (state) {
      case 'open':
        return select('Open', 'green');
      case 'closed':
        return select('Closed', 'red');
    }
  }

  export function select(name: string, color: SelectColor = 'default'): CustomTypes.Select {
    return {
      type: 'select',
      select: {
        name: name,
        color: color,
      },
    };
  }

  export function multiSelect(names: string[]): CustomTypes.MultiSelect {
    return {
      type: 'multi_select',
      multi_select: names.map(name => {
        return {
          name: name,
        };
      }),
    };
  }

  export function url(url: string): CustomTypes.URL {
    return {
      type: 'url',
      url,
    };
  }

  export function person(githubUsernames: string[], userRelations: userRelationGithubNotionType[]): CustomTypes.People {
    const people: CustomTypes.Person[] = [];

    githubUsernames.forEach(githubUsername => {
      const relation = userRelations.find(relation => relation.githubUsername === githubUsername);
      if (relation) {
        people.push({
          id: relation.notionUserId,
          object: 'user',
        });
      }
    });

    return {
      people
    };
  }

  export function relation(projectKey: string, notionProjects: NotionProjectInfo[]): CustomTypes.Relation {
    // console.log(`Creating relation for project key: ${projectKey}`);
    // console.log(`Available Notion projects: ${notionProjects.map(project => project.projectKey).join(', ')}`);

    const projectId = notionProjects.find(project => projectKey === project.projectKey)?.id;
    
    // console.log(`Found project ID: ${projectId}`);

    return {
      type: 'relation',
      relation: projectId ? [
        {
          id: projectId || '',
        },
      ] : [],
    }
  }

  export function status(githubStatus: string): CustomTypes.Status {
    switch (githubStatus) {
      case 'In progress':
        return {
          status: {
            name: "In progress"
          }
        }
      case 'Done':
        return {
          status: {
            name: "Done"
          }
        }
      case 'In review':
        return {
          status: {
            name: "To be checked"
          }
        }
      default:
        return {
          status: {
            name: "Not started"
          }
        };
    }
  }
}