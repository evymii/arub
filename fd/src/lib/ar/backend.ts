export type ApiBuilding = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
};

export type ApiSample = {
  id: string;
  embedding: number[];
  lat: number | null;
  lng: number | null;
  source: "camera" | "photo";
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
  payload: { name: string; lat?: number; lng?: number },
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
  const buildings = await listBuildings(token);
  const perBuilding = await Promise.all(
    buildings.map(async (building) => ({
      building,
      samples: await listBuildingSamples(token, building.id),
    })),
  );
  return perBuilding;
}
