import fs from "node:fs";
import path from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { GraphQLClient } from "graphql-request";
import {
  FEATURE_REF_REGEX,
  REQUIREMENT_REF_REGEX,
  NOTE_REF_REGEX,
  AhaRecord,
  FeatureResponse,
  RequirementResponse,
  PageResponse,
  SearchResponse,
  ReleasesResponse,
  Release,
  WorkflowStatus,
  CreateFeatureResponse,
  UpdateFeatureResponse,
  AddCommentResponse,
  AhaRestFeatureShow,
  AhaRestRequirementShow,
} from "./types.js";
import {
  getFeatureQuery,
  getRequirementQuery,
  getPageQuery,
  searchDocumentsQuery,
  getReleasesQuery,
  createFeatureMutation,
  updateFeatureMutation,
  addFeatureCommentMutation,
  getWorkflowIdQuery,
  getFeaturesQuery,
} from "./queries.js";

/** Max upload size for filePath / fileBase64 (multipart). URL-based uploads are not limited here. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function guessContentTypeFromFileName(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".csv": "text/csv",
    ".html": "text/html",
    ".htm": "text/html",
  };
  return map[ext];
}

export class Handlers {
  constructor(
    private client: GraphQLClient,
    private defaultProductId?: string,
    private apiToken?: string,
    private domain?: string,
    private defaultUserEmail?: string
  ) {}

  async handleGetRecord(request: any) {
    const { reference } = request.params.arguments as { reference: string };

    if (!reference) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Reference number is required"
      );
    }

    try {
      let result: AhaRecord | undefined;

      if (FEATURE_REF_REGEX.test(reference)) {
        const data = await this.client.request<FeatureResponse>(
          getFeatureQuery,
          {
            id: reference,
          }
        );
        result = data.feature;
      } else if (REQUIREMENT_REF_REGEX.test(reference)) {
        const data = await this.client.request<RequirementResponse>(
          getRequirementQuery,
          { id: reference }
        );
        result = data.requirement;
      } else {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Invalid reference number format. Expected DEVELOP-123 or ADT-123-1"
        );
      }

      if (!result) {
        return {
          content: [
            {
              type: "text",
              text: `No record found for reference ${reference}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch record: ${errorMessage}`
      );
    }
  }

  async handleGetPage(request: any) {
    const { reference, includeParent = false } = request.params.arguments as {
      reference: string;
      includeParent?: boolean;
    };

    if (!reference) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Reference number is required"
      );
    }

    if (!NOTE_REF_REGEX.test(reference)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Invalid reference number format. Expected ABC-N-213"
      );
    }

    try {
      const data = await this.client.request<PageResponse>(getPageQuery, {
        id: reference,
        includeParent,
      });

      if (!data.page) {
        return {
          content: [
            {
              type: "text",
              text: `No page found for reference ${reference}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data.page, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch page: ${errorMessage}`
      );
    }
  }

  async handleSearchDocuments(request: any) {
    const { query, searchableType = "Page" } = request.params.arguments as {
      query: string;
      searchableType?: string;
    };

    if (!query) {
      throw new McpError(ErrorCode.InvalidParams, "Search query is required");
    }

    try {
      const data = await this.client.request<SearchResponse>(
        searchDocumentsQuery,
        {
          query,
          searchableType: [searchableType],
        }
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data.searchDocuments, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search documents: ${errorMessage}`
      );
    }
  }

  async handleGetReleases(request: any) {
    const { productId } = request.params.arguments as {
      productId?: string;
    };

    const finalProductId = productId || this.defaultProductId;

    if (!finalProductId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Product ID is required. Provide it as a parameter or set AHA_PRODUCT_ID environment variable"
      );
    }

    try {
      const allReleases: Release[] = [];
      let currentPage = 1;
      let totalPages = 1;
      let isLastPage = false;

      // Fetch all pages of releases
      do {
        const data: ReleasesResponse = await this.client.request<ReleasesResponse>(
          getReleasesQuery,
          {
            productId: finalProductId,
            page: currentPage,
          }
        );

        allReleases.push(...data.releases.nodes);
        
        // Update pagination info
        totalPages = data.releases.totalPages;
        isLastPage = data.releases.isLastPage;
        currentPage = data.releases.currentPage;

        // Move to next page if not on last page
        if (!isLastPage) {
          currentPage++;
        }
      } while (!isLastPage && currentPage <= totalPages);

      // Sort releases by ID (ascending) which correlates with creation order
      const sortedReleases = [...allReleases].sort((a, b) => {
        const idA = BigInt(a.id);
        const idB = BigInt(b.id);
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(sortedReleases, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch releases: ${errorMessage}`
      );
    }
  }

  async handleCreateFeature(request: any) {
    const { name, description, releaseId } = request.params.arguments as {
      name: string;
      description: string;
      releaseId: string;
    };

    if (!name) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Feature name is required"
      );
    }

    if (!description) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Feature description is required"
      );
    }

    if (!releaseId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Release ID is required"
      );
    }

    try {
      const data = await this.client.request<CreateFeatureResponse>(
        createFeatureMutation,
        {
          name,
          description,
          releaseId,
        }
      );

      if (data.createFeature.errors && data.createFeature.errors.length > 0) {
        const errorMessages = data.createFeature.errors
          .flatMap((e) => e.attributes.flatMap((attr) => attr.messages))
          .join(", ");
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to create feature: ${errorMessages}`
        );
      }

      if (!data.createFeature.feature) {
        throw new McpError(
          ErrorCode.InternalError,
          "Feature creation failed: No feature returned"
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data.createFeature.feature, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create feature: ${errorMessage}`
      );
    }
  }

  async handleUpdateFeature(request: any) {
    const {
      reference,
      release,
      assignedToUser,
      assignedToUserEmail,
      workflowStatus,
    } = request.params.arguments as {
      reference: string;
      release?: string;
      assignedToUser?: string;
      assignedToUserEmail?: string;
      workflowStatus?: string;
    };

    if (!reference) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Feature reference is required"
      );
    }

    if (!FEATURE_REF_REGEX.test(reference)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Invalid feature reference format. Expected DEVELOP-123"
      );
    }

    // Check if we have at least one property to update
    // If defaultUserEmail is set, we can assign to that user even if no explicit assignment is provided
    const hasAssignment = assignedToUser || assignedToUserEmail || this.defaultUserEmail;
    if (!release && !hasAssignment && !workflowStatus) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "At least one property (release, assignedToUser, assignedToUserEmail, or workflowStatus) must be provided"
      );
    }

    try {
      // If email is provided, look up the user ID
      // If no email is provided but defaultUserEmail is set, use that
      const emailToUse = assignedToUserEmail || this.defaultUserEmail;
      let finalAssignedToUser = assignedToUser;
      if (emailToUse && !assignedToUser) {
        finalAssignedToUser = await this.getUserByEmail(emailToUse);
      }

      // If workflowStatus is provided, check if it's a name or ID
      // If it contains non-digit characters, treat it as a name and look up the ID
      let finalWorkflowStatusId = workflowStatus;
      if (workflowStatus && !/^\d+$/.test(workflowStatus)) {
        // It's a name, not an ID - need to look it up
        // First get the feature to find its project ID
        const featureData = await this.client.request<FeatureResponse>(
          getFeatureQuery,
          { id: reference }
        );
        
        if (!featureData.feature || !featureData.feature.project?.id) {
          throw new McpError(
            ErrorCode.InternalError,
            "Could not find project ID for feature"
          );
        }

        // Query workflow statuses using REST API
        const matchingStatus = await this.getWorkflowStatusByName(
          featureData.feature.project.id,
          workflowStatus
        );

        finalWorkflowStatusId = matchingStatus;
      }

      // Build the variables object for the mutation
      // Only include relationship inputs that are actually set
      const variables: any = {
        featureId: reference,
      };

      if (release) {
        variables.release = { id: release };
      }
      
      if (finalAssignedToUser) {
        variables.assignedToUser = { id: finalAssignedToUser };
      }
      
      if (finalWorkflowStatusId) {
        variables.workflowStatus = { id: finalWorkflowStatusId };
      }

      const data = await this.client.request<UpdateFeatureResponse>(
        updateFeatureMutation,
        variables
      );

      if (data.updateFeature.errors && data.updateFeature.errors.length > 0) {
        const errorMessages = data.updateFeature.errors
          .flatMap((e) => e.attributes.flatMap((attr) => attr.messages))
          .join(", ");
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to update feature: ${errorMessages}`
        );
      }

      if (!data.updateFeature.feature) {
        throw new McpError(
          ErrorCode.InternalError,
          "Feature update failed: No feature returned"
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data.updateFeature.feature, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to update feature: ${errorMessage}`
      );
    }
  }

  async handleGetWorkflowStatuses(request: any) {
    const { projectId } = request.params.arguments as {
      projectId?: string;
    };

    if (!projectId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Project ID is required"
      );
    }

    try {
      const statuses = await this.getWorkflowStatuses(projectId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(statuses, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch workflow statuses: ${errorMessage}`
      );
    }
  }

  async getWorkflowStatuses(projectId: string): Promise<WorkflowStatus[]> {
    if (!this.apiToken || !this.domain) {
      throw new McpError(
        ErrorCode.InternalError,
        "API token and domain are required to query workflow statuses"
      );
    }

    try {
      // First, get the workflow ID from a feature's workflow status
      const workflowIdData = await this.client.request<{
        features: {
          nodes: Array<{
            workflowStatus: {
              workflow: {
                id: string;
              } | null;
            } | null;
          }>;
        };
      }>(getWorkflowIdQuery, {
        projectId: projectId,
      });

      const workflowId = workflowIdData.features?.nodes?.[0]?.workflowStatus?.workflow?.id;
      
      if (workflowId) {
        // Use REST API to get workflow details including all statuses
        // Reference: https://www.aha.io/api/resources/workflows/get_a_specific_workflow
        const url = `https://${this.domain}.aha.io/api/v1/workflows/${workflowId}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        });

        if (response.ok) {
          const workflowData = await response.json();
          const workflow = workflowData.workflow || workflowData;
          
          // Extract workflow statuses from the workflow response
          // The API response structure may vary, so we'll try multiple possible fields
          const statuses = workflow.workflow_statuses || workflow.statuses || workflow.workflowStatuses || [];
          
          if (Array.isArray(statuses) && statuses.length > 0) {
            return statuses.map((status: any) => ({
              id: String(status.id || status.workflow_status?.id),
              name: status.name || status.workflow_status?.name,
            })).filter((status: WorkflowStatus) => status.id && status.name);
          }
        }
      }

      // Fallback: Query features to collect unique workflow statuses
      // This is a workaround if the workflow definition isn't accessible
      const statusMap = new Map<string, WorkflowStatus>();
      let currentPage = 1;
      let totalPages = 1;
      let isLastPage = false;

      do {
        const featuresData = await this.client.request<{
          features: {
            nodes: Array<{
              workflowStatus: {
                id: string;
                name: string;
              } | null;
            }>;
            currentPage: number;
            totalPages: number;
            isLastPage: boolean;
          };
        }>(getFeaturesQuery, {
          projectId: projectId,
          page: currentPage,
        });

        if (!featuresData.features?.nodes) {
          break;
        }

        // Extract unique workflow statuses from features
        for (const feature of featuresData.features.nodes) {
          if (feature.workflowStatus) {
            statusMap.set(feature.workflowStatus.id, {
              id: feature.workflowStatus.id,
              name: feature.workflowStatus.name,
            });
          }
        }

        // Update pagination info
        totalPages = featuresData.features.totalPages;
        isLastPage = featuresData.features.isLastPage;
        currentPage = featuresData.features.currentPage;

        // Move to next page if not on last page
        if (!isLastPage) {
          currentPage++;
        }
      } while (!isLastPage && currentPage <= totalPages);

      const statuses = Array.from(statusMap.values());
      
      if (statuses.length === 0) {
        throw new McpError(
          ErrorCode.InternalError,
          "No workflow statuses found for project"
        );
      }

      return statuses;
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to query workflow statuses: ${errorMessage}`
      );
    }
  }

  async getWorkflowStatusByName(projectId: string, statusName: string): Promise<string> {
    const statuses = await this.getWorkflowStatuses(projectId);

    if (statuses.length === 0) {
      throw new McpError(
        ErrorCode.InternalError,
        `No workflow statuses found for project ${projectId}`
      );
    }

    // Find the workflow status with matching name (case-insensitive)
    const matchingStatus = statuses.find(
      (status) => status.name.toLowerCase() === statusName.toLowerCase()
    );

    if (!matchingStatus) {
      const availableStatuses = statuses.map((s) => s.name).join(", ");
      throw new McpError(
        ErrorCode.InvalidParams,
        `Workflow status "${statusName}" not found. Available statuses: ${availableStatuses}`
      );
    }

    return matchingStatus.id;
  }

  async getUserByEmail(email: string): Promise<string> {
    if (!this.apiToken || !this.domain) {
      throw new McpError(
        ErrorCode.InternalError,
        "API token and domain are required to query users"
      );
    }

    try {
      const url = `https://${this.domain}.aha.io/api/v1/users?email=${encodeURIComponent(email)}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const users = data.users || [];

      if (users.length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No user found with email: ${email}`
        );
      }

      if (users.length > 1) {
        throw new McpError(
          ErrorCode.InternalError,
          `Multiple users found with email: ${email}`
        );
      }

      return users[0].id;
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to query user: ${errorMessage}`
      );
    }
  }

  async handleGetUserByEmail(request: any) {
    const { email } = request.params.arguments as { email: string };

    if (!email) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Email address is required"
      );
    }

    try {
      const userId = await this.getUserByEmail(email);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: userId,
                email: email,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get user: ${errorMessage}`
      );
    }
  }

  async handleGetConfiguredUser(request: any) {
    if (!this.defaultUserEmail) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "AHA_USER_EMAIL environment variable is not configured"
      );
    }

    try {
      const userId = await this.getUserByEmail(this.defaultUserEmail);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                email: this.defaultUserEmail,
                userId: userId,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get configured user: ${errorMessage}`
      );
    }
  }

  async handleAddFeatureComment(request: any) {
    const { reference, comment } = request.params.arguments as {
      reference: string;
      comment: string;
    };

    if (!reference) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Feature reference is required"
      );
    }

    if (!FEATURE_REF_REGEX.test(reference)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Invalid feature reference format. Expected DEVELOP-123"
      );
    }

    if (!comment) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Comment is required"
      );
    }

    try {
      const data = await this.client.request<AddCommentResponse>(
        addFeatureCommentMutation,
        {
          featureId: reference,
          comment,
        }
      );

      if (data.createComment.errors && data.createComment.errors.length > 0) {
        const errorMessages = data.createComment.errors
          .flatMap((e) => 
            e.attributes.flatMap((attr) => attr.messages)
          )
          .join(", ");
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to add comment: ${errorMessages}`
        );
      }

      if (!data.createComment.comment || !data.createComment.comment.commentable) {
        throw new McpError(
          ErrorCode.InternalError,
          "Comment addition failed: No feature returned"
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                feature: data.createComment.comment.commentable,
                message: "Comment added successfully",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to add comment: ${errorMessage}`
      );
    }
  }

  private async ahaRestGetJson<T>(path: string): Promise<T> {
    if (!this.apiToken || !this.domain) {
      throw new McpError(
        ErrorCode.InternalError,
        "API token and domain are required"
      );
    }
    const url = `https://${this.domain}.aha.io/api/v1${path}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new McpError(
        ErrorCode.InternalError,
        `Aha! API error ${response.status}: ${errText || response.statusText}`
      );
    }
    return (await response.json()) as T;
  }

  private extractDescriptionNoteId(
    data: AhaRestFeatureShow | AhaRestRequirementShow,
    kind: "feature" | "requirement"
  ): string | undefined {
    if (kind === "feature") {
      const d = data as AhaRestFeatureShow;
      return (
        d.feature?.description?.id ??
        d.description?.id ??
        (data as { feature?: { description?: { id?: string } } }).feature
          ?.description?.id
      );
    }
    const d = data as AhaRestRequirementShow;
    return (
      d.requirement?.description?.id ??
      d.description?.id ??
      (data as { requirement?: { description?: { id?: string } } })
        .requirement?.description?.id
    );
  }

  private async getRecordDescriptionNoteId(reference: string): Promise<string> {
    let path: string;
    let kind: "feature" | "requirement";

    if (FEATURE_REF_REGEX.test(reference)) {
      path = `/features/${encodeURIComponent(reference)}`;
      kind = "feature";
    } else if (REQUIREMENT_REF_REGEX.test(reference)) {
      path = `/requirements/${encodeURIComponent(reference)}`;
      kind = "requirement";
    } else {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Invalid reference format. Expected a feature (e.g. DEVELOP-123) or requirement (e.g. ADT-123-1)"
      );
    }

    const data =
      kind === "feature"
        ? await this.ahaRestGetJson<AhaRestFeatureShow>(path)
        : await this.ahaRestGetJson<AhaRestRequirementShow>(path);

    const noteId = this.extractDescriptionNoteId(data, kind);
    if (!noteId) {
      throw new McpError(
        ErrorCode.InternalError,
        "Could not find description note id for this record (missing description.id in API response)"
      );
    }
    return noteId;
  }

  private async postNoteAttachmentMultipart(
    noteId: string,
    fileBytes: Buffer,
    fileName: string,
    contentType?: string
  ): Promise<unknown> {
    if (!this.apiToken || !this.domain) {
      throw new McpError(
        ErrorCode.InternalError,
        "API token and domain are required"
      );
    }
    const url = `https://${this.domain}.aha.io/api/v1/notes/${encodeURIComponent(noteId)}/attachments`;
    const blob = new Blob([fileBytes], {
      type: contentType || "application/octet-stream",
    });
    const formData = new FormData();
    formData.append("attachment[data]", blob, fileName);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
      },
      body: formData,
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!response.ok) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to upload attachment: ${response.status} ${JSON.stringify(body)}`
      );
    }
    return body;
  }

  private async postNoteAttachmentUrl(
    noteId: string,
    fileUrl: string,
    fileName: string,
    contentType: string
  ): Promise<unknown> {
    if (!this.apiToken || !this.domain) {
      throw new McpError(
        ErrorCode.InternalError,
        "API token and domain are required"
      );
    }
    const url = `https://${this.domain}.aha.io/api/v1/notes/${encodeURIComponent(noteId)}/attachments`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        attachment: {
          file_url: fileUrl,
          content_type: contentType,
          file_name: fileName,
        },
      }),
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!response.ok) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create attachment from URL: ${response.status} ${JSON.stringify(body)}`
      );
    }
    return body;
  }

  async handleAddRecordAttachment(request: any) {
    const {
      reference,
      fileBase64,
      fileName,
      contentType,
      fileUrl,
      filePath,
    } = request.params.arguments as {
      reference: string;
      fileBase64?: string;
      fileName?: string;
      contentType?: string;
      fileUrl?: string;
      /** Absolute path on the machine running the MCP server (avoids large base64 in tool args). */
      filePath?: string;
    };

    if (!reference) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "reference is required"
      );
    }

    const hasPath =
      filePath != null && String(filePath).trim().length > 0;
    const hasFile =
      fileBase64 != null && String(fileBase64).length > 0;
    const hasUrl = fileUrl != null && String(fileUrl).trim().length > 0;

    const modeCount = [hasPath, hasFile, hasUrl].filter(Boolean).length;
    if (modeCount > 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Provide exactly one of filePath, fileBase64, or fileUrl"
      );
    }
    if (modeCount === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "One of filePath, fileBase64, or fileUrl is required"
      );
    }

    if (hasFile) {
      if (!fileName || !String(fileName).trim()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "fileName is required when using fileBase64"
        );
      }
    }
    if (hasUrl) {
      if (!fileName || !String(fileName).trim()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "fileName is required when using fileUrl"
        );
      }
      if (!contentType || !String(contentType).trim()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "contentType is required when using fileUrl"
        );
      }
    }

    try {
      const noteId = await this.getRecordDescriptionNoteId(reference);

      let result: unknown;
      if (hasPath) {
        const resolved = path.resolve(String(filePath).trim());
        if (!fs.existsSync(resolved)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `filePath does not exist: ${resolved}`
          );
        }
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `filePath must be a regular file: ${resolved}`
          );
        }
        if (stat.size > MAX_ATTACHMENT_BYTES) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `File too large (${stat.size} bytes > ${MAX_ATTACHMENT_BYTES} bytes). Use fileUrl for large files.`
          );
        }
        const buffer = fs.readFileSync(resolved);
        if (buffer.length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "File is empty"
          );
        }
        const finalName =
          (fileName && String(fileName).trim()) || path.basename(resolved);
        if (!finalName || finalName === "." || finalName === "..") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Could not derive a valid fileName from filePath"
          );
        }
        const ct =
          (contentType && String(contentType).trim()) ||
          guessContentTypeFromFileName(finalName);
        result = await this.postNoteAttachmentMultipart(
          noteId,
          buffer,
          finalName,
          ct || undefined
        );
      } else if (hasFile) {
        let buffer: Buffer;
        try {
          buffer = Buffer.from(String(fileBase64), "base64");
        } catch {
          throw new McpError(
            ErrorCode.InvalidParams,
            "fileBase64 must be valid base64"
          );
        }
        if (buffer.length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Decoded file is empty"
          );
        }
        if (buffer.length > MAX_ATTACHMENT_BYTES) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Decoded file too large (${buffer.length} bytes > ${MAX_ATTACHMENT_BYTES} bytes). Use filePath or fileUrl.`
          );
        }
        result = await this.postNoteAttachmentMultipart(
          noteId,
          buffer,
          String(fileName).trim(),
          contentType?.trim() || undefined
        );
      } else {
        result = await this.postNoteAttachmentUrl(
          noteId,
          String(fileUrl).trim(),
          String(fileName).trim(),
          String(contentType).trim()
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                reference,
                descriptionNoteId: noteId,
                attachment: result,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("API Error:", errorMessage);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to add attachment: ${errorMessage}`
      );
    }
  }
}
