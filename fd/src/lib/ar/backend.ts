export type ApiBuilding = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  /** Persisted “not a building” / ¬bldg flag from the API. */
  isNotBuilding?: boolean;
};

export type ApiSample = {
  id: string;
  embedding: number[];
  lat: number | null;
  lng: number | null;
  source: "camera" | "photo";
};

export type ApiIssue = {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "consensus" | "accepted" | "resolved";
  buildingId: string | null;
  buildingLabel: string | null;
  matchCount: number;
  uniqueUsers: number;
  supportCount: number;
  commentCount: number;
  totalMatchEvents: number;
  lat: number | null;
  lng: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiIssueComment = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { id: string; name: string | null; email: string };
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const TOKEN_KEY = "ar.backend.token.v1";

type RegisterResponse = {
  token: string;
};

function randomGuestIdentity() {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return {
    email: `ar_guest_${suffix}@example.com`,
    name: `AR Guest ${suffix.slice(-4)}`,
    password: `guest_${suffix}_secure`,
  };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${response.status} ${path}: ${text || response.statusText}`);
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
}

export async function getOrCreateAuthToken(): Promise<string> {
  const existing = localStorage.getItem(TOKEN_KEY);
  if (existing) return existing;

  const guest = randomGuestIdentity();
  const response = await apiFetch<RegisterResponse>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(guest),
  });
  localStorage.setItem(TOKEN_KEY, response.token);
  return response.token;
}

export async function listBuildings(token: string): Promise<ApiBuilding[]> {
  const result = await apiFetch<{ buildings: ApiBuilding[] }>("/buildings", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return result.buildings;
}

export async function createBuilding(
  token: string,
  payload: { name: string; lat?: number; lng?: number; isNotBuilding?: boolean },
): Promise<ApiBuilding> {
  const result = await apiFetch<{ building: ApiBuilding }>("/buildings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return result.building;
}

export async function updateBuilding(
  token: string,
  buildingId: string,
  payload: { isNotBuilding?: boolean },
): Promise<ApiBuilding & { sampleCount?: number }> {
  const result = await apiFetch<{ building: ApiBuilding & { sampleCount?: number } }>(
    `/buildings/${buildingId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  return result.building;
}

export async function deleteBuilding(token: string, buildingId: string): Promise<void> {
  await apiFetch<void>(`/buildings/${buildingId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function createSample(
  token: string,
  payload: {
    buildingId: string;
    embedding: number[];
    lat?: number;
    lng?: number;
    source: "camera" | "photo";
  },
): Promise<ApiSample> {
  const metadata = JSON.stringify(payload);
  const formData = new FormData();
  formData.set("metadata", metadata);

  const result = await apiFetch<{ sample: ApiSample }>("/samples", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  return result.sample;
}

export async function listBuildingSamples(
  token: string,
  buildingId: string,
): Promise<ApiSample[]> {
  const result = await apiFetch<{ samples: ApiSample[] }>(`/buildings/${buildingId}/samples`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return result.samples;
}

export async function listAllSamplesByBuilding(token: string): Promise<
  Array<{
    building: ApiBuilding;
    samples: ApiSample[];
  }>
> {
  const result = await apiFetch<{
    buildings: Array<ApiBuilding & { samples: ApiSample[] }>;
  }>("/buildings/with-samples", {
    headers: { Authorization: `Bearer ${token}` },
  });

  return result.buildings.map((building) => ({
    building: {
      id: building.id,
      name: building.name,
      lat: building.lat,
      lng: building.lng,
      isNotBuilding: building.isNotBuilding,
    },
    samples: building.samples,
  }));
}

export async function createIssue(
  token: string,
  payload: {
    title: string;
    description?: string;
    buildingId?: string;
    embedding?: number[];
    lat?: number;
    lng?: number;
  },
): Promise<ApiIssue> {
  const metadata = JSON.stringify(payload);
  const formData = new FormData();
  formData.set("metadata", metadata);
  const result = await apiFetch<{ issue: ApiIssue }>("/issues", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  return result.issue;
}

export async function getIssueByLabel(token: string, label: string): Promise<ApiIssue | null> {
  const result = await apiFetch<{ issue: ApiIssue | null }>(
    `/issues/by-label/${encodeURIComponent(label)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return result.issue;
}

export async function supportIssue(token: string, issueId: string): Promise<ApiIssue | null> {
  const result = await apiFetch<{ issue: ApiIssue | null }>(`/issues/${issueId}/support`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return result.issue;
}

export async function recordMatchEvent(
  token: string,
  issueId: string,
  payload: { buildingId: string },
): Promise<ApiIssue | null> {
  const result = await apiFetch<{ issue: ApiIssue | null }>(`/issues/${issueId}/match-events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return result.issue;
}

export async function listIssueComments(
  token: string,
  issueId: string,
): Promise<ApiIssueComment[]> {
  const result = await apiFetch<{ comments: ApiIssueComment[] }>(`/issues/${issueId}/comments`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return result.comments;
}

export async function createIssueComment(
  token: string,
  issueId: string,
  body: string,
): Promise<ApiIssueComment> {
  const result = await apiFetch<{ comment: ApiIssueComment }>(`/issues/${issueId}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  return result.comment;
}
