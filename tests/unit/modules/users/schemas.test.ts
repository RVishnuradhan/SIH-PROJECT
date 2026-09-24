import { describe, expect, it } from "vitest";

import {
  changeOwnPasswordSchema,
  createUserSchema,
  deactivateUserSchema,
  signInSchema,
  usernameSchema,
} from "@/modules/users/schemas";

const valid = {
  name: "Priya",
  username: "priya",
  email: "",
  role: "staff",
  password: "long-enough-pass",
  confirmPassword: "long-enough-pass",
};

function errors(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message]),
  );
}

describe("usernameSchema", () => {
  it("stores usernames trimmed and in lower case", () => {
    expect(usernameSchema.parse("  Ravi.K_2  ")).toBe("ravi.k_2");
  });

  it.each([
    ["ab", "Use at least 3 characters"],
    ["a".repeat(31), "Use at most 30 characters"],
    ["ravi kumar", "Use only letters, numbers, dots and underscores"],
    ["ravi@sms", "Use only letters, numbers, dots and underscores"],
    ["ரவி", "Use only letters, numbers, dots and underscores"],
  ])("refuses %j", (value, message) => {
    expect(errors(usernameSchema.safeParse(value))).toEqual({ "": message });
  });
});

describe("createUserSchema", () => {
  it("accepts a new staff member without an email", () => {
    expect(createUserSchema.parse(valid)).toEqual({ ...valid, email: undefined });
  });

  it("normalises the email", () => {
    expect(createUserSchema.parse({ ...valid, email: " Priya@Example.com " }).email).toBe(
      "priya@example.com",
    );
  });

  it("explains every problem in plain words", () => {
    const result = createUserSchema.safeParse({
      name: " ",
      username: "x",
      email: "not-an-email",
      role: "owner",
      password: "short",
      confirmPassword: "different",
    });
    expect(errors(result)).toEqual({
      name: "Enter the person's name",
      username: "Use at least 3 characters",
      email: "Enter a valid email address, or leave it empty",
      role: "Choose a role",
      password: "Use at least 10 characters",
    });
  });

  it("requires the password to be typed the same twice", () => {
    expect(
      errors(createUserSchema.safeParse({ ...valid, confirmPassword: "long-enough-typo" })),
    ).toEqual({
      confirmPassword: "The passwords don't match",
    });
  });

  it("limits passwords to 128 characters", () => {
    const long = "x".repeat(129);
    expect(
      errors(createUserSchema.safeParse({ ...valid, password: long, confirmPassword: long })),
    ).toEqual({
      password: "Use at most 128 characters",
    });
  });

  it("never trims a password", () => {
    const spaced = "  spaced passphrase  ";
    expect(
      createUserSchema.parse({ ...valid, password: spaced, confirmPassword: spaced }).password,
    ).toBe(spaced);
  });
});

describe("changeOwnPasswordSchema", () => {
  it("needs the current password and a different new one", () => {
    expect(
      errors(
        changeOwnPasswordSchema.safeParse({
          currentPassword: "",
          password: "same-password-1",
          confirmPassword: "same-password-1",
        }),
      ),
    ).toEqual({ currentPassword: "Enter your current password" });
    expect(
      errors(
        changeOwnPasswordSchema.safeParse({
          currentPassword: "same-password-1",
          password: "same-password-1",
          confirmPassword: "same-password-1",
        }),
      ),
    ).toEqual({ password: "Choose a password different from the current one" });
  });
});

describe("deactivateUserSchema", () => {
  it("treats an empty reason as no reason", () => {
    expect(deactivateUserSchema.parse({ userId: "u1", reason: "   " })).toEqual({
      userId: "u1",
      reason: undefined,
    });
  });
});

describe("signInSchema", () => {
  it("asks for both fields", () => {
    expect(errors(signInSchema.safeParse({ username: " ", password: "" }))).toEqual({
      username: "Enter your username",
      password: "Enter your password",
    });
  });
});
