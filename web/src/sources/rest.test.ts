import { describe, expect, it, vi } from "vitest";

import { RestSource } from "./rest";

/**
 * How a list of ids reaches the server.
 *
 * Ids were joined on a comma and split on every comma at the other end, so an
 * id containing one - legal, since a GTFS id is any UTF-8 string - was
 * requested as two ids and matched nothing.
 */
describe("geojson id encoding", () => {
  const capture = () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ type: "FeatureCollection", features: [] }),
      } as Response);
    });
    return calls;
  };

  it("sends one parameter per id", async () => {
    const calls = capture();
    await new RestSource().geojson("stops", ["ST1", "ST2"]);
    expect(calls[0]).toContain("stop_ids=ST1&stop_ids=ST2");
  });

  it("keeps an id containing a comma as one id", async () => {
    const calls = capture();
    await new RestSource().geojson("locations", ["zone,1"]);
    // Encoded, and exactly once - not two parameters.
    expect(calls[0]).toContain("location_ids=zone%2C1");
    expect(calls[0].match(/location_ids=/g)).toHaveLength(1);
  });

  it("asks for everything when given no ids", async () => {
    const calls = capture();
    await new RestSource().geojson("shapes");
    expect(calls[0]).toBe("/api/geojson/shapes");
  });

  it("highlights a route through its shape", async () => {
    const calls = capture();
    await new RestSource().geojson("routes", ["SH1"]);
    expect(calls[0]).toContain("shape_ids=SH1");
  });
});
