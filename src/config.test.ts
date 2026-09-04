import { describe, expect, it } from "vitest";
import {
  configuredIssuer,
  DEFAULT_CLIENT_ID,
  issuerForEnvironment,
  normalizeIssuer,
} from "./config.js";

it("uses the registered PEP CLI client ID by default", () => {
  expect(DEFAULT_CLIENT_ID).toBe("1b916aae96f69a535d7a1a30c8f2e1dc");
});

describe("configuredIssuer", () => {
  it("uses the issuer built into the executable", () => {
    expect(configuredIssuer(undefined)).toBe("https://pep-webapp-dev.onrender.com");
  });

  it("allows --issuer to override the built-in issuer", () => {
    expect(configuredIssuer("https://explicit.example.com")).toBe(
      "https://explicit.example.com",
    );
  });
});

describe("issuerForEnvironment", () => {
  it("maps build environments to their fixed issuers", () => {
    expect(issuerForEnvironment("development")).toBe(
      "https://pep-webapp-dev.onrender.com",
    );
    expect(issuerForEnvironment("production")).toBe("https://pep.newlandnpt.us");
  });
});

describe("normalizeIssuer", () => {
  it("removes trailing slash, query, and fragment", () => {
    expect(normalizeIssuer("https://pep.example.com/?ignored=1#fragment")).toBe(
      "https://pep.example.com",
    );
  });

  it("allows HTTP only for a local development issuer", () => {
    expect(normalizeIssuer("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(() => normalizeIssuer("http://pep.example.com")).toThrow(/HTTPS/);
  });
});
