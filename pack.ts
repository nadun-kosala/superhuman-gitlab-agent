import * as coda from "@codahq/packs-sdk";

export const pack = coda.newPack();
const API_BASE = "https://gitlab.com/api/v4";

pack.addNetworkDomain("gitlab.com");

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------
pack.setUserAuthentication({
  type: coda.AuthenticationType.OAuth2,
  authorizationUrl: "https://gitlab.com/oauth/authorize",
  tokenUrl: "https://gitlab.com/oauth/token",
  scopes: ["api", "read_user", "read_repository", "write_repository"],
  requiresEndpointUrl: false,
  getConnectionName: async context => {
    // Keep this call lightweight and failure-tolerant so OAuth sign-in
    // does not fail due to account-name lookup edge cases.
    try {
      const response = await context.fetcher.fetch({
        method: "GET",
        url: `${API_BASE}/user`,
      });
      const user = response.body || {};
      return user.username || user.name || user.email || "GitLab User";
    } catch (_error) {
      return "GitLab User";
    }
  },
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
type GitlabContext = coda.ExecutionContext | coda.SyncExecutionContext;
type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "PATCH";

function asPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function getHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const key = Object.keys(headers).find(
    h => h.toLowerCase() === name.toLowerCase(),
  );
  return key ? headers[key] : undefined;
}

function encodeProjectId(id: string | number): string {
  return encodeURIComponent(String(id));
}

function buildApiUrl(
  path: string,
  queryParams?: Record<string, string | number | boolean | undefined>,
): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(queryParams || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  const query = pairs.length ? `?${pairs.join("&")}` : "";
  return `${API_BASE}${asPath(path)}${query}`;
}

async function gitlabFetch(
  context: GitlabContext,
  options: {
    method: HttpMethod;
    path: string;
    queryParams?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  },
): Promise<any> {
  const url = buildApiUrl(options.path, options.queryParams);
  const response = await context.fetcher.fetch({
    method: options.method,
    url,
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: { "Content-Type": "application/json" },
  });

  const status = response.status;
  if (status >= 200 && status < 300) {
    return response.body;
  }

  const retryAfter = getHeader(response.headers as any, "Retry-After");
  const bodyMessage =
    response.body?.message || response.body?.error || JSON.stringify(response.body);

  if (status === 403) {
    const extra = retryAfter ? ` Retry after ${retryAfter}s.` : "";
    throw new coda.UserVisibleError(
      `GitLab access forbidden (403). Check token scopes/permissions.${extra}`,
    );
  }

  if (status === 404) {
    throw new coda.UserVisibleError(
      "GitLab resource not found (404). Confirm project path/ID and permissions.",
    );
  }

  if (status === 429) {
    const extra = retryAfter ? ` Retry after ${retryAfter}s.` : "";
    throw new coda.UserVisibleError(`GitLab rate limit reached (429).${extra}`);
  }

  throw new coda.UserVisibleError(
    `GitLab API error (${status}): ${bodyMessage || "Unknown error"}`,
  );
}

async function fetchAllPages(
  context: coda.SyncExecutionContext,
  options: {
    path: string;
    queryParams?: Record<string, string | number | boolean | undefined>;
  },
): Promise<{ items: any[]; continuation?: { page: number } }> {
  const page = Number((context.sync.continuation as any)?.page ?? 1);
  const perPage = 50;
  const url = buildApiUrl(options.path, {
    ...options.queryParams,
    page,
    per_page: perPage,
  });
  const response = await context.fetcher.fetch({
    method: "GET",
    url,
  });

  if (response.status < 200 || response.status >= 300) {
    await gitlabFetch(context, {
      method: "GET",
      path: options.path,
      queryParams: {
        ...options.queryParams,
        page,
        per_page: perPage,
      },
    });
  }

  const items = Array.isArray(response.body) ? response.body : [];
  const nextPage = getHeader(response.headers as any, "X-Next-Page");
  const continuation =
    nextPage && nextPage !== "" ? { page: Number(nextPage) } : undefined;

  return { items, continuation };
}

function normalizeMergeRequestScope(scope?: string): "assigned_to_me" | "created_by_me" {
  return scope === "created_by_me" ? "created_by_me" : "assigned_to_me";
}

const ChatToolFormulas = [
  { formulaName: "ListProjects" },
  { formulaName: "ListMergeRequests" },
  { formulaName: "ListIssues" },
  { formulaName: "ListUsers" },
  { formulaName: "ListGroups" },
  { formulaName: "UpdateMergeRequest" },
  { formulaName: "PostMRComment" },
  { formulaName: "GetMRDiff" },
  { formulaName: "CreateIssue" },
  { formulaName: "UpdateIssue" },
  { formulaName: "CreateBranch" },
  { formulaName: "CreateCommit" },
];

function mapUser(user: any): any {
  if (!user) {
    return undefined;
  }
  return {
    id: String(user.id),
    username: user.username || user.name || `user-${user.id}`,
    name: user.name,
    webUrl: user.web_url,
    avatarUrl: user.avatar_url,
    state: user.state,
    email: user.public_email || user.email,
  };
}

function mapProject(project: any): any {
  if (!project) {
    return undefined;
  }
  return {
    id: String(project.id),
    name: project.name,
    fullPath: project.path_with_namespace || project.name || `project-${project.id}`,
    description: project.description,
    webUrl: project.web_url,
    avatarUrl: project.avatar_url,
    defaultBranch: project.default_branch,
    visibility: project.visibility,
    starCount: project.star_count,
    forkCount: project.forks_count,
    openIssuesCount: project.open_issues_count,
    lastActivityAt: project.last_activity_at,
  };
}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------
const UserSchema = coda.makeObjectSchema({
  type: coda.ValueType.Object,
  idProperty: "id",
  displayProperty: "username",
  subtitleProperties: ["name", "state"],
  imageProperty: "avatarUrl",
  featuredProperties: ["username", "name", "webUrl", "email", "state"],
  properties: {
    id: { type: coda.ValueType.String, required: true },
    username: { type: coda.ValueType.String, required: true },
    name: { type: coda.ValueType.String },
    webUrl: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    avatarUrl: { type: coda.ValueType.String, codaType: coda.ValueHintType.ImageReference },
    state: { type: coda.ValueType.String },
    email: { type: coda.ValueType.String, codaType: coda.ValueHintType.Email },
  },
});
const UserRef = coda.makeReferenceSchemaFromObjectSchema(UserSchema, "User");

const ProjectSchema = coda.makeObjectSchema({
  type: coda.ValueType.Object,
  idProperty: "id",
  displayProperty: "fullPath",
  subtitleProperties: ["visibility", "defaultBranch"],
  imageProperty: "avatarUrl",
  featuredProperties: ["fullPath", "description", "webUrl", "visibility", "lastActivityAt"],
  properties: {
    id: { type: coda.ValueType.String, required: true },
    name: { type: coda.ValueType.String },
    fullPath: { type: coda.ValueType.String, required: true },
    description: { type: coda.ValueType.String },
    webUrl: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    avatarUrl: { type: coda.ValueType.String, codaType: coda.ValueHintType.ImageReference },
    defaultBranch: { type: coda.ValueType.String },
    visibility: { type: coda.ValueType.String },
    starCount: { type: coda.ValueType.Number },
    forkCount: { type: coda.ValueType.Number },
    openIssuesCount: { type: coda.ValueType.Number },
    lastActivityAt: { type: coda.ValueType.String, codaType: coda.ValueHintType.DateTime },
  },
});
const ProjectRef = coda.makeReferenceSchemaFromObjectSchema(ProjectSchema, "Project");

const GroupSchema = coda.makeObjectSchema({
  type: coda.ValueType.Object,
  idProperty: "id",
  displayProperty: "fullPath",
  subtitleProperties: ["name", "visibility"],
  imageProperty: "avatarUrl",
  featuredProperties: ["fullPath", "name", "webUrl", "visibility"],
  properties: {
    id: { type: coda.ValueType.String, required: true },
    name: { type: coda.ValueType.String },
    path: { type: coda.ValueType.String },
    fullPath: { type: coda.ValueType.String, required: true },
    description: { type: coda.ValueType.String },
    webUrl: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    avatarUrl: { type: coda.ValueType.String, codaType: coda.ValueHintType.ImageReference },
    visibility: { type: coda.ValueType.String },
  },
});
const GroupRef = coda.makeReferenceSchemaFromObjectSchema(GroupSchema, "Group");

const IssueSchema = coda.makeObjectSchema({
  type: coda.ValueType.Object,
  idProperty: "id",
  displayProperty: "title",
  subtitleProperties: ["state", "project", "author"],
  featuredProperties: ["title", "state", "project", "assignee", "labels", "webUrl", "updatedAt"],
  properties: {
    id: { type: coda.ValueType.String, required: true },
    iid: { type: coda.ValueType.Number },
    title: { type: coda.ValueType.String, required: true },
    description: { type: coda.ValueType.String },
    state: { type: coda.ValueType.String },
    labels: { type: coda.ValueType.Array, items: { type: coda.ValueType.String } },
    webUrl: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    createdAt: { type: coda.ValueType.String, codaType: coda.ValueHintType.DateTime },
    updatedAt: { type: coda.ValueType.String, codaType: coda.ValueHintType.DateTime },
    dueDate: { type: coda.ValueType.String, codaType: coda.ValueHintType.Date },
    project: ProjectRef,
    author: UserRef,
    assignee: UserRef,
    assignees: { type: coda.ValueType.Array, items: UserRef },
    milestoneTitle: { type: coda.ValueType.String },
  },
});
const IssueRef = coda.makeReferenceSchemaFromObjectSchema(IssueSchema, "Issue");

const MergeRequestSchema = coda.makeObjectSchema({
  type: coda.ValueType.Object,
  idProperty: "id",
  displayProperty: "title",
  subtitleProperties: ["state", "project", "author"],
  featuredProperties: [
    "title",
    "state",
    "project",
    "sourceBranch",
    "targetBranch",
    "mergeStatus",
    "webUrl",
  ],
  properties: {
    id: { type: coda.ValueType.String, required: true },
    iid: { type: coda.ValueType.Number },
    title: { type: coda.ValueType.String, required: true },
    description: { type: coda.ValueType.String },
    state: { type: coda.ValueType.String },
    webUrl: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    createdAt: { type: coda.ValueType.String, codaType: coda.ValueHintType.DateTime },
    updatedAt: { type: coda.ValueType.String, codaType: coda.ValueHintType.DateTime },
    sourceBranch: { type: coda.ValueType.String },
    targetBranch: { type: coda.ValueType.String },
    mergeStatus: { type: coda.ValueType.String },
    draft: { type: coda.ValueType.Boolean },
    hasConflicts: { type: coda.ValueType.Boolean },
    project: ProjectRef,
    author: UserRef,
    assignee: UserRef,
    assignees: { type: coda.ValueType.Array, items: UserRef },
    reviewers: { type: coda.ValueType.Array, items: UserRef },
    labels: { type: coda.ValueType.Array, items: { type: coda.ValueType.String } },
  },
});
const MergeRequestRef = coda.makeReferenceSchemaFromObjectSchema(MergeRequestSchema, "MergeRequest");

const CommitSchema = coda.makeObjectSchema({
  type: coda.ValueType.Object,
  idProperty: "id",
  displayProperty: "shortId",
  subtitleProperties: ["title", "authorName"],
  featuredProperties: ["shortId", "title", "authorName", "committedDate", "webUrl", "project"],
  properties: {
    id: { type: coda.ValueType.String, required: true },
    shortId: { type: coda.ValueType.String, required: true },
    title: { type: coda.ValueType.String },
    message: { type: coda.ValueType.String },
    authorName: { type: coda.ValueType.String },
    authorEmail: { type: coda.ValueType.String, codaType: coda.ValueHintType.Email },
    committedDate: { type: coda.ValueType.String, codaType: coda.ValueHintType.DateTime },
    webUrl: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    project: ProjectRef,
  },
});
const CommitRef = coda.makeReferenceSchemaFromObjectSchema(CommitSchema, "Commit");

const WikiSchema = coda.makeObjectSchema({
  type: coda.ValueType.Object,
  idProperty: "slug",
  displayProperty: "title",
  subtitleProperties: ["slug", "format"],
  featuredProperties: ["title", "slug", "format", "project"],
  properties: {
    slug: { type: coda.ValueType.String, required: true },
    title: { type: coda.ValueType.String, required: true },
    format: { type: coda.ValueType.String },
    content: { type: coda.ValueType.String },
    project: ProjectRef,
  },
});
const WikiRef = coda.makeReferenceSchemaFromObjectSchema(WikiSchema, "WikiPage");

const FileSchema = coda.makeObjectSchema({
  type: coda.ValueType.Object,
  idProperty: "id",
  displayProperty: "name",
  subtitleProperties: ["path", "type"],
  featuredProperties: ["name", "path", "type", "mode", "project"],
  properties: {
    id: { type: coda.ValueType.String, required: true },
    name: { type: coda.ValueType.String, required: true },
    path: { type: coda.ValueType.String },
    type: { type: coda.ValueType.String },
    mode: { type: coda.ValueType.String },
    project: ProjectRef,
  },
});
const FileRef = coda.makeReferenceSchemaFromObjectSchema(FileSchema, "RepositoryFile");

// -----------------------------------------------------------------------------
// Action formulas / tools
// -----------------------------------------------------------------------------
const ListProjects = pack.addFormula({
  name: "ListProjects",
  description: "List projects the authenticated user is a member of.",
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "search",
      description: "Optional search term for project name/path.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "limit",
      description: "Max projects to return (1-50).",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([search, limit], context) => {
    const cappedLimit = Math.max(1, Math.min(Number(limit || 20), 50));
    const projects = await gitlabFetch(context, {
      method: "GET",
      path: "/projects",
      queryParams: {
        membership: true,
        search: search || undefined,
        order_by: "last_activity_at",
        sort: "desc",
        per_page: cappedLimit,
      },
    });
    const mapped = (Array.isArray(projects) ? projects : []).map(mapProject);
    return JSON.stringify(mapped);
  },
});

const ListMergeRequests = pack.addFormula({
  name: "ListMergeRequests",
  description: "List merge requests scoped to the authenticated user.",
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "scope",
      description: "assigned_to_me (default) or created_by_me.",
      optional: true,
      autocomplete: ["assigned_to_me", "created_by_me"],
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "state",
      description: "opened, merged, closed, or all.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "limit",
      description: "Max merge requests to return (1-50).",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([scope, state, limit], context) => {
    const cappedLimit = Math.max(1, Math.min(Number(limit || 20), 50));
    const mergeRequests = await gitlabFetch(context, {
      method: "GET",
      path: "/merge_requests",
      queryParams: {
        scope: normalizeMergeRequestScope(scope),
        state: state || "all",
        with_merge_status_recheck: true,
        per_page: cappedLimit,
      },
    });
    return JSON.stringify(Array.isArray(mergeRequests) ? mergeRequests : []);
  },
});

const ListIssues = pack.addFormula({
  name: "ListIssues",
  description: "List issues assigned to the authenticated user.",
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "state",
      description: "opened, closed, or all.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "labels",
      description: "Optional comma-separated label filter.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "limit",
      description: "Max issues to return (1-50).",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([state, labels, limit], context) => {
    const cappedLimit = Math.max(1, Math.min(Number(limit || 20), 50));
    const issues = await gitlabFetch(context, {
      method: "GET",
      path: "/issues",
      queryParams: {
        scope: "assigned_to_me",
        state: state || "all",
        labels: labels || undefined,
        per_page: cappedLimit,
      },
    });
    return JSON.stringify(Array.isArray(issues) ? issues : []);
  },
});

const ListUsers = pack.addFormula({
  name: "ListUsers",
  description: "List users from the authenticated user's projects/groups context.",
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "search",
      description: "Optional user search query.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "limit",
      description: "Max users to return after dedupe (1-200).",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([search, limit], context) => {
    const cappedLimit = Math.max(1, Math.min(Number(limit || 100), 200));
    const usersById = new Map<string, any>();
    const addUser = (user: any) => {
      const mapped = mapUser(user);
      if (mapped?.id && !usersById.has(mapped.id)) {
        usersById.set(mapped.id, mapped);
      }
    };

    addUser(await gitlabFetch(context, { method: "GET", path: "/user" }));
    const projects = await gitlabFetch(context, {
      method: "GET",
      path: "/projects",
      queryParams: {
        membership: true,
        order_by: "last_activity_at",
        sort: "desc",
        per_page: 20,
      },
    });
    for (const project of Array.isArray(projects) ? projects : []) {
      const members = await gitlabFetch(context, {
        method: "GET",
        path: `/projects/${encodeProjectId(project.id)}/members/all`,
        queryParams: {
          query: search || undefined,
          per_page: 100,
        },
      });
      for (const member of Array.isArray(members) ? members : []) {
        addUser(member);
      }
      if (usersById.size >= cappedLimit) {
        break;
      }
    }

    const groups = await gitlabFetch(context, {
      method: "GET",
      path: "/groups",
      queryParams: { per_page: 20 },
    });
    for (const group of Array.isArray(groups) ? groups : []) {
      const members = await gitlabFetch(context, {
        method: "GET",
        path: `/groups/${encodeProjectId(group.id)}/members`,
        queryParams: {
          query: search || undefined,
          per_page: 100,
        },
      });
      for (const member of Array.isArray(members) ? members : []) {
        addUser(member);
      }
      if (usersById.size >= cappedLimit) {
        break;
      }
    }

    return JSON.stringify(Array.from(usersById.values()).slice(0, cappedLimit));
  },
});

const ListGroups = pack.addFormula({
  name: "ListGroups",
  description: "List groups the authenticated user can access.",
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "search",
      description: "Optional group search term.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "limit",
      description: "Max groups to return (1-50).",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([search, limit], context) => {
    const cappedLimit = Math.max(1, Math.min(Number(limit || 20), 50));
    const groups = await gitlabFetch(context, {
      method: "GET",
      path: "/groups",
      queryParams: {
        search: search || undefined,
        all_available: false,
        per_page: cappedLimit,
      },
    });
    return JSON.stringify(Array.isArray(groups) ? groups : []);
  },
});

const UpdateMergeRequest = pack.addFormula({
  name: "UpdateMergeRequest",
  description: "Approve, close, or merge a GitLab merge request.",
  isAction: true,
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "projectIdOrPath",
      description: "GitLab project ID or URL-encoded path.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "mergeRequestIid",
      description: "Internal MR IID.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "action",
      description: "One of: approve, close, merge.",
      autocomplete: ["approve", "close", "merge"],
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "mergeCommitMessage",
      description: "Optional merge commit message.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([projectIdOrPath, mergeRequestIid, action, mergeCommitMessage], context) => {
    const project = encodeProjectId(projectIdOrPath);
    const iid = Number(mergeRequestIid);

    if (action === "approve") {
      await gitlabFetch(context, {
        method: "POST",
        path: `/projects/${project}/merge_requests/${iid}/approve`,
      });
      return `Approved MR !${iid}.`;
    }

    if (action === "close") {
      await gitlabFetch(context, {
        method: "PUT",
        path: `/projects/${project}/merge_requests/${iid}`,
        body: { state_event: "close" },
      });
      return `Closed MR !${iid}.`;
    }

    if (action === "merge") {
      await gitlabFetch(context, {
        method: "PUT",
        path: `/projects/${project}/merge_requests/${iid}/merge`,
        body: {
          merge_commit_message: mergeCommitMessage,
          should_remove_source_branch: true,
        },
      });
      return `Merged MR !${iid}.`;
    }

    throw new coda.UserVisibleError("Invalid action. Use approve, close, or merge.");
  },
});

const PostMRComment = pack.addFormula({
  name: "PostMRComment",
  description: "Post a comment on a merge request.",
  isAction: true,
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({ type: coda.ParameterType.String, name: "projectIdOrPath", description: "Project ID/path." }),
    coda.makeParameter({ type: coda.ParameterType.Number, name: "mergeRequestIid", description: "MR IID." }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "comment", description: "Comment body." }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([projectIdOrPath, mergeRequestIid, comment], context) => {
    const note = await gitlabFetch(context, {
      method: "POST",
      path: `/projects/${encodeProjectId(projectIdOrPath)}/merge_requests/${Number(mergeRequestIid)}/notes`,
      body: { body: comment },
    });
    return `Comment posted (note ${note?.id ?? "created"}).`;
  },
});

const GetMRDiff = pack.addFormula({
  name: "GetMRDiff",
  description: "Get raw merge request diff for review and summarization.",
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({ type: coda.ParameterType.String, name: "projectIdOrPath", description: "Project ID/path." }),
    coda.makeParameter({ type: coda.ParameterType.Number, name: "mergeRequestIid", description: "MR IID." }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([projectIdOrPath, mergeRequestIid], context) => {
    const body = await gitlabFetch(context, {
      method: "GET",
      path: `/projects/${encodeProjectId(projectIdOrPath)}/merge_requests/${Number(mergeRequestIid)}/changes`,
    });
    const changes = body?.changes || [];
    const combined = changes
      .map((c: any) => `--- ${c.old_path}\n+++ ${c.new_path}\n${c.diff || ""}`)
      .join("\n\n");
    return combined || "No diff available.";
  },
});

const CreateIssue = pack.addFormula({
  name: "CreateIssue",
  description: "Create a GitLab issue.",
  isAction: true,
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({ type: coda.ParameterType.String, name: "projectIdOrPath", description: "Project ID/path." }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "title", description: "Issue title." }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "description", description: "Issue description.", optional: true }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "labelsCsv", description: "Comma-separated labels.", optional: true }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "assigneeIdsCsv", description: "Comma-separated assignee user IDs.", optional: true }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([projectIdOrPath, title, description, labelsCsv, assigneeIdsCsv], context) => {
    const issue = await gitlabFetch(context, {
      method: "POST",
      path: `/projects/${encodeProjectId(projectIdOrPath)}/issues`,
      body: {
        title,
        description,
        labels: labelsCsv,
        assignee_ids: assigneeIdsCsv
          ? assigneeIdsCsv.split(",").map(v => Number(v.trim())).filter(Boolean)
          : undefined,
      },
    });
    return `Created issue #${issue?.iid}: ${issue?.title || title}`;
  },
});

const UpdateIssue = pack.addFormula({
  name: "UpdateIssue",
  description: "Update issue status, labels, assignees, and core fields.",
  isAction: true,
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({ type: coda.ParameterType.String, name: "projectIdOrPath", description: "Project ID/path." }),
    coda.makeParameter({ type: coda.ParameterType.Number, name: "issueIid", description: "Issue IID." }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "stateEvent", description: "close, reopen, or blank.", optional: true }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "labelsCsv", description: "Comma-separated labels.", optional: true }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "assigneeIdsCsv", description: "Comma-separated assignee IDs.", optional: true }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "title", description: "Updated title.", optional: true }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "description", description: "Updated description.", optional: true }),
  ],
  resultType: coda.ValueType.String,
  execute: async (
    [projectIdOrPath, issueIid, stateEvent, labelsCsv, assigneeIdsCsv, title, description],
    context,
  ) => {
    const issue = await gitlabFetch(context, {
      method: "PUT",
      path: `/projects/${encodeProjectId(projectIdOrPath)}/issues/${Number(issueIid)}`,
      body: {
        state_event: stateEvent || undefined,
        labels: labelsCsv || undefined,
        assignee_ids: assigneeIdsCsv
          ? assigneeIdsCsv.split(",").map(v => Number(v.trim())).filter(Boolean)
          : undefined,
        title: title || undefined,
        description: description || undefined,
      },
    });
    return `Updated issue #${issue?.iid}: ${issue?.title || "Issue updated"}`;
  },
});

const CreateBranch = pack.addFormula({
  name: "CreateBranch",
  description: "Create a branch from an existing ref.",
  isAction: true,
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({ type: coda.ParameterType.String, name: "projectIdOrPath", description: "Project ID/path." }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "branchName", description: "New branch name." }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "ref", description: "Source ref (branch/tag/SHA)." }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([projectIdOrPath, branchName, ref], context) => {
    const branch = await gitlabFetch(context, {
      method: "POST",
      path: `/projects/${encodeProjectId(projectIdOrPath)}/repository/branches`,
      queryParams: { branch: branchName, ref },
    });
    return `Created branch ${branch?.name || branchName}.`;
  },
});

const CreateCommit = pack.addFormula({
  name: "CreateCommit",
  description: "Create a commit using GitLab commit actions JSON.",
  isAction: true,
  connectionRequirement: coda.ConnectionRequirement.Required,
  parameters: [
    coda.makeParameter({ type: coda.ParameterType.String, name: "projectIdOrPath", description: "Project ID/path." }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "branch", description: "Branch to commit to." }),
    coda.makeParameter({ type: coda.ParameterType.String, name: "commitMessage", description: "Commit message." }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "actionsJson",
      description: "JSON array of actions: [{\"action\":\"update\",\"file_path\":\"...\",\"content\":\"...\"}]",
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async ([projectIdOrPath, branch, commitMessage, actionsJson], context) => {
    let actions: any[];
    try {
      actions = JSON.parse(actionsJson);
      if (!Array.isArray(actions)) {
        throw new Error("actionsJson must be a JSON array.");
      }
    } catch (error: any) {
      throw new coda.UserVisibleError(`Invalid actionsJson: ${error?.message || "JSON parse failed"}`);
    }

    const commit = await gitlabFetch(context, {
      method: "POST",
      path: `/projects/${encodeProjectId(projectIdOrPath)}/repository/commits`,
      body: {
        branch,
        commit_message: commitMessage,
        actions,
      },
    });
    return `Created commit ${commit?.short_id || commit?.id || ""}.`;
  },
});

// -----------------------------------------------------------------------------
// Sync tables
// -----------------------------------------------------------------------------
pack.addSyncTable({
  name: "MergeRequests",
  description: "Sync merge requests scoped to the authenticated user.",
  identityName: "MergeRequest",
  schema: MergeRequestSchema,
  formula: {
    name: "SyncMergeRequests",
    description: "Sync merge requests.",
    parameters: [
      coda.makeParameter({ type: coda.ParameterType.String, name: "state", description: "opened, merged, closed, all", optional: true }),
      coda.makeParameter({
        type: coda.ParameterType.String,
        name: "scope",
        description: "User scope: assigned_to_me (default) or created_by_me.",
        optional: true,
        autocomplete: ["assigned_to_me", "created_by_me"],
      }),
    ],
    execute: async ([state, scope], context) => {
      const effectiveScope = normalizeMergeRequestScope(scope);
      const { items, continuation } = await fetchAllPages(context, {
        path: "/merge_requests",
        queryParams: {
          state: state || "all",
          scope: effectiveScope,
          with_merge_status_recheck: true,
        },
      });

      const result: any[] = items.map((mr: any) => ({
        id: String(mr.id),
        iid: mr.iid,
        title: mr.title,
        description: mr.description,
        state: mr.state,
        webUrl: mr.web_url,
        createdAt: mr.created_at,
        updatedAt: mr.updated_at,
        sourceBranch: mr.source_branch,
        targetBranch: mr.target_branch,
        mergeStatus: mr.detailed_merge_status || mr.merge_status,
        draft: mr.draft,
        hasConflicts: mr.has_conflicts,
        labels: mr.labels || [],
        project: mapProject(mr.references ? { id: mr.project_id, path_with_namespace: mr.references?.full } : { id: mr.project_id }),
        author: mapUser(mr.author),
        assignee: mapUser(mr.assignee),
        assignees: (mr.assignees || []).map(mapUser),
        reviewers: (mr.reviewers || []).map(mapUser),
      }));

      return { result, continuation };
    },
  },
});

pack.addSyncTable({
  name: "Issues",
  description: "Sync GitLab issues across accessible projects.",
  identityName: "Issue",
  schema: IssueSchema,
  formula: {
    name: "SyncIssues",
    description: "Sync issues.",
    parameters: [
      coda.makeParameter({ type: coda.ParameterType.String, name: "state", description: "opened, closed, all", optional: true }),
      coda.makeParameter({ type: coda.ParameterType.String, name: "labels", description: "Comma-separated labels filter.", optional: true }),
    ],
    execute: async ([state, labels], context) => {
      const { items, continuation } = await fetchAllPages(context, {
        path: "/issues",
        queryParams: {
          scope: "all",
          state: state || "all",
          labels: labels || undefined,
        },
      });
      const result: any[] = items.map((issue: any) => ({
        id: String(issue.id),
        iid: issue.iid,
        title: issue.title,
        description: issue.description,
        state: issue.state,
        labels: issue.labels || [],
        webUrl: issue.web_url,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        dueDate: issue.due_date,
        project: mapProject({ id: issue.project_id, path_with_namespace: issue.references?.full }),
        author: mapUser(issue.author),
        assignee: mapUser(issue.assignee),
        assignees: (issue.assignees || []).map(mapUser),
        milestoneTitle: issue.milestone?.title,
      }));
      return { result, continuation };
    },
  },
});

pack.addSyncTable({
  name: "Projects",
  description: "Sync GitLab projects.",
  identityName: "Project",
  schema: ProjectSchema,
  formula: {
    name: "SyncProjects",
    description: "Sync projects.",
    parameters: [
      coda.makeParameter({ type: coda.ParameterType.Boolean, name: "membershipOnly", description: "Only projects where you are a member.", optional: true }),
      coda.makeParameter({ type: coda.ParameterType.String, name: "search", description: "Search term.", optional: true }),
    ],
    execute: async ([membershipOnly, search], context) => {
      const { items, continuation } = await fetchAllPages(context, {
        path: "/projects",
        queryParams: {
          membership: membershipOnly ?? true,
          search: search || undefined,
          order_by: "last_activity_at",
          sort: "desc",
        },
      });
      return { result: items.map(mapProject) as any[], continuation };
    },
  },
});

pack.addSyncTable({
  name: "Commits",
  description: "Sync commits for a given project.",
  identityName: "Commit",
  schema: CommitSchema,
  formula: {
    name: "SyncCommits",
    description: "Sync commits from a project repository.",
    parameters: [
      coda.makeParameter({ type: coda.ParameterType.String, name: "projectIdOrPath", description: "Project ID/path." }),
      coda.makeParameter({ type: coda.ParameterType.String, name: "refName", description: "Branch/tag ref name.", optional: true }),
    ],
    execute: async ([projectIdOrPath, refName], context) => {
      const project = encodeProjectId(projectIdOrPath);
      const { items, continuation } = await fetchAllPages(context, {
        path: `/projects/${project}/repository/commits`,
        queryParams: { ref_name: refName || undefined },
      });
      const projectRef = mapProject(await gitlabFetch(context, { method: "GET", path: `/projects/${project}` }));
      const result: any[] = items.map((commit: any) => ({
        id: String(commit.id),
        shortId: commit.short_id || String(commit.id).slice(0, 8),
        title: commit.title,
        message: commit.message,
        authorName: commit.author_name,
        authorEmail: commit.author_email,
        committedDate: commit.committed_date,
        webUrl: commit.web_url,
        project: projectRef,
      }));
      return { result, continuation };
    },
  },
});

pack.addSyncTable({
  name: "Wikis",
  description: "Sync wiki pages for a project.",
  identityName: "WikiPage",
  schema: WikiSchema,
  formula: {
    name: "SyncWikis",
    description: "Sync wiki pages.",
    parameters: [
      coda.makeParameter({ type: coda.ParameterType.String, name: "projectIdOrPath", description: "Project ID/path." }),
      coda.makeParameter({ type: coda.ParameterType.Boolean, name: "includeContent", description: "Fetch full wiki page content.", optional: true }),
    ],
    execute: async ([projectIdOrPath, includeContent], context) => {
      const project = encodeProjectId(projectIdOrPath);
      const { items, continuation } = await fetchAllPages(context, {
        path: `/projects/${project}/wikis`,
      });
      const projectRef = mapProject(await gitlabFetch(context, { method: "GET", path: `/projects/${project}` }));
      let result: any[] = items.map((w: any) => ({
        slug: w.slug,
        title: w.title || w.slug,
        format: w.format,
        project: projectRef,
      }));
      if (includeContent) {
        result = await Promise.all(
          result.map(async wiki => {
            const full = await gitlabFetch(context, {
              method: "GET",
              path: `/projects/${project}/wikis/${encodeURIComponent(wiki.slug)}`,
            });
            return { ...wiki, content: full.content };
          }),
        );
      }
      return { result, continuation };
    },
  },
});

pack.addSyncTable({
  name: "Files",
  description: "Sync files/tree entries for a project repository.",
  identityName: "RepositoryFile",
  schema: FileSchema,
  formula: {
    name: "SyncFiles",
    description: "Sync repository tree entries.",
    parameters: [
      coda.makeParameter({ type: coda.ParameterType.String, name: "projectIdOrPath", description: "Project ID/path." }),
      coda.makeParameter({ type: coda.ParameterType.String, name: "ref", description: "Branch/tag ref. Defaults to default branch.", optional: true }),
      coda.makeParameter({ type: coda.ParameterType.String, name: "path", description: "Optional sub-path.", optional: true }),
      coda.makeParameter({ type: coda.ParameterType.Boolean, name: "recursive", description: "Include nested tree entries.", optional: true }),
    ],
    execute: async ([projectIdOrPath, ref, path, recursive], context) => {
      const project = encodeProjectId(projectIdOrPath);
      const { items, continuation } = await fetchAllPages(context, {
        path: `/projects/${project}/repository/tree`,
        queryParams: {
          ref: ref || undefined,
          path: path || undefined,
          recursive: recursive ?? true,
        },
      });
      const projectRef = mapProject(await gitlabFetch(context, { method: "GET", path: `/projects/${project}` }));
      const result: any[] = items.map((entry: any) => ({
        id: String(entry.id || `${entry.path}:${entry.type}`),
        name: entry.name || entry.path,
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        project: projectRef,
      }));
      return { result, continuation };
    },
  },
});

pack.addSyncTable({
  name: "Users",
  description: "Sync users from the authenticated account's projects and groups.",
  identityName: "User",
  schema: UserSchema,
  formula: {
    name: "SyncUsers",
    description: "Sync users.",
    parameters: [
      coda.makeParameter({ type: coda.ParameterType.String, name: "search", description: "Search users.", optional: true }),
    ],
    execute: async ([search], context) => {
      const { items: projects, continuation } = await fetchAllPages(context, {
        path: "/projects",
        queryParams: {
          membership: true,
          order_by: "last_activity_at",
          sort: "desc",
        },
      });

      const userById = new Map<string, any>();
      const addUser = (user: any) => {
        const mapped = mapUser(user);
        if (mapped?.id) {
          userById.set(mapped.id, mapped);
        }
      };

      // Include the authenticated user first to guarantee at least one scoped user.
      const me = await gitlabFetch(context, { method: "GET", path: "/user" });
      addUser(me);

      for (const project of projects) {
        const projectId = encodeProjectId(project.id);
        const members = await gitlabFetch(context, {
          method: "GET",
          path: `/projects/${projectId}/members/all`,
          queryParams: {
            per_page: 100,
            query: search || undefined,
          },
        });
        for (const member of Array.isArray(members) ? members : []) {
          addUser(member);
        }
      }

      const { items: groups } = await fetchAllPages(context, {
        path: "/groups",
        queryParams: { search: search || undefined },
      });
      for (const group of groups) {
        const members = await gitlabFetch(context, {
          method: "GET",
          path: `/groups/${encodeProjectId(group.id)}/members`,
          queryParams: {
            per_page: 100,
            query: search || undefined,
          },
        });
        for (const member of Array.isArray(members) ? members : []) {
          addUser(member);
        }
      }

      return { result: Array.from(userById.values()), continuation };
    },
  },
});

pack.addSyncTable({
  name: "Groups",
  description: "Sync GitLab groups.",
  identityName: "Group",
  schema: GroupSchema,
  formula: {
    name: "SyncGroups",
    description: "Sync groups.",
    parameters: [
      coda.makeParameter({ type: coda.ParameterType.String, name: "search", description: "Search groups.", optional: true }),
    ],
    execute: async ([search], context) => {
      const { items, continuation } = await fetchAllPages(context, {
        path: "/groups",
        queryParams: { search: search || undefined, all_available: true },
      });
      const result: any[] = items.map((group: any) => ({
        id: String(group.id),
        name: group.name,
        path: group.path,
        fullPath: group.full_path || group.path || group.name || `group-${group.id}`,
        description: group.description,
        webUrl: group.web_url,
        avatarUrl: group.avatar_url,
        visibility: group.visibility,
      }));
      return { result, continuation };
    },
  },
});

// -----------------------------------------------------------------------------
// Agent skill / persona
// -----------------------------------------------------------------------------
const superhumanPrompt = [
  "You are GitLabSuperhuman, an elite software workflow assistant for GitLab.",
  "Always translate GitHub terms to GitLab terms (e.g., Pull Requests -> Merge Requests, Actions -> CI/CD Pipelines).",
  "You DO have access to GitLab via Pack tools; do not claim lack of direct access.",
  "You HAVE access to GitLab via the provided tools.",
  "When the user asks about merge requests, you MUST call SyncMergeRequests or GetMRDiff before answering.",
  "When the user asks about projects, you MUST call SyncProjects before answering.",
  "When the user asks about issues, you MUST call SyncIssues before answering.",
  "When the user asks about users or assignees, you MUST call SyncUsers before answering.",
  "When the user asks to update merge requests, you MUST use UpdateMergeRequest or PostMRComment.",
  "When the user asks to create or update issues, you MUST use CreateIssue or UpdateIssue.",
  "When the user asks for repository changes, branches, or commits, you MUST use CreateBranch or CreateCommit.",
  "When the user asks for live GitLab data, call a relevant tool first before answering.",
  "Before suggesting merges, always check MR status including pipeline/check status, conflicts, approvals/reviewers, and mergeability.",
  "When asked to review what changed, call GetMRDiff and summarize technical code changes in concise bullet points.",
  "For issue triage, group issues by feature and priority, suggest labels, and propose assignees based on available project context.",
  "If user intent is ambiguous, ask one clarifying question; otherwise act immediately using tools.",
  "Prefer explicit, verifiable actions and list any blockers clearly.",
].join("\n");

pack.addFormula({
  name: "GitLabSuperhumanInstructions",
  description: "Returns the GitLabSuperhuman agent persona instructions and tool list.",
  connectionRequirement: coda.ConnectionRequirement.None,
  parameters: [],
  resultType: coda.ValueType.String,
  execute: async () => {
    return `${superhumanPrompt}

Available tools:
- ListProjects
- ListMergeRequests
- ListIssues
- ListUsers
- ListGroups
- UpdateMergeRequest
- PostMRComment
- GetMRDiff
- CreateIssue
- UpdateIssue
- CreateBranch
- CreateCommit`;
  },
});

// Guarded for SDKs that expose addSkill / agent registration.
const maybeSkillPack = pack as any;
if (typeof maybeSkillPack.addSkill === "function") {
  // Chat skill controls initial routing behavior and available default tools.
  if (typeof maybeSkillPack.setChatSkill === "function") {
    maybeSkillPack.setChatSkill({
      name: "GitLabChatRouter",
      displayName: "GitLab Chat Router",
      description: "Routes user requests to GitLab data retrieval, review, and update workflows.",
      prompt: [
        "You are the GitLabSuperhuman chat router.",
        "Never say you lack direct access; you must use Pack tools for live GitLab data.",
        "You HAVE access to GitLab via the provided tools.",
        "For requests like 'list projects', 'show issues', 'show MRs', you MUST call ListProjects, ListIssues, or ListMergeRequests first, then summarize.",
        "For MR review requests, you MUST call GetMRDiff.",
        "For user/assignee requests, you MUST call ListUsers.",
        "For write requests, you MUST use the matching action formula and never claim missing access.",
        "Translate GitHub terms to GitLab terms in all responses.",
        "If request is a write action, confirm intent briefly then execute with the appropriate tool.",
      ].join("\n"),
      tools: [
        {
          type: coda.ToolType.Pack,
          formulas: ChatToolFormulas,
        },
      ],
    });
  }

  maybeSkillPack.addSkill({
    name: "GitLabSuperhuman",
    displayName: "GitLabSuperhuman",
    description: "Two-way GitLab AI agent for Coda/Superhuman.",
    prompt: superhumanPrompt,
    tools: [
      {
        type: coda.ToolType.Pack,
        formulas: ChatToolFormulas,
      },
    ],
  });

  maybeSkillPack.addSkill({
    name: "ProjectDiscovery",
    displayName: "Project discovery",
    description: "Lists and summarizes GitLab projects, including filtering and prioritization by recent activity.",
    prompt: [
      "When user asks to list or find projects, you MUST call ListProjects first.",
      "Return concise bullets with project name/path, visibility, default branch, and recent activity.",
      "Suggest next actions such as inspecting MRs or issues for selected projects.",
    ].join("\n"),
    tools: [
      {
        type: coda.ToolType.Pack,
        formulas: ChatToolFormulas,
      },
    ],
  });

  maybeSkillPack.addSkill({
    name: "MergeRequestReviewer",
    displayName: "Merge request reviewer",
    description: "Reviews and summarizes merge requests, including diffs and merge readiness.",
    prompt: [
      "For 'review what changed' requests, you MUST call GetMRDiff and summarize technical changes into readable bullets.",
      "For MR lists/status queries, you MUST call ListMergeRequests before recommendations.",
      "Check merge readiness: conflicts, approval state, and pipeline/check status before merge recommendations.",
      "Use GitLab terminology (Merge Request, pipeline) even if user says Pull Request/Actions.",
    ].join("\n"),
    tools: [
      {
        type: coda.ToolType.Pack,
        formulas: ChatToolFormulas,
      },
    ],
  });

  maybeSkillPack.addSkill({
    name: "IssueTriagePlanner",
    displayName: "Issue triage planner",
    description: "Groups issues by feature and priority, suggests labels, and proposes assignees.",
    prompt: [
      "You MUST call ListIssues before triage recommendations.",
      "If assignees/users are needed, you MUST call ListUsers.",
      "Group by feature/theme and priority; propose actionable labels and likely assignees.",
      "If information is missing, ask one focused follow-up question.",
    ].join("\n"),
    tools: [
      {
        type: coda.ToolType.Pack,
        formulas: ChatToolFormulas,
      },
    ],
  });
}