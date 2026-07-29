export interface RepositoryName {
  owner: string;
  name: string;
}

const REPOSITORY_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export function isRepositoryName(value: string): boolean {
  return REPOSITORY_NAME.test(value);
}

export function parseRepositoryName(value: string): RepositoryName {
  if (!isRepositoryName(value)) {
    throw new Error(`Invalid GitHub repository "${value}"; expected owner/repository`);
  }
  const [owner, name] = value.split("/") as [string, string];
  return { owner, name };
}
