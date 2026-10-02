import { describe, expect, test } from "bun:test";
import { orderDecisionSchema, placeOrderSchema } from "../src/schemas/order.schema.ts";

describe("placeOrderSchema", () => {
  test("a table alone is enough", () => {
    expect(placeOrderSchema.parse({ tableNumber: "12" })).toEqual({ tableNumber: "12" });
  });

  test("a phone alone is enough, normalised to 10 digits", () => {
    expect(placeOrderSchema.parse({ phone: "+91 98765-43210" }).phone).toBe("9876543210");
    expect(placeOrderSchema.parse({ phone: "09876543210" }).phone).toBe("9876543210");
  });

  test("neither table nor phone is refused", () => {
    expect(placeOrderSchema.safeParse({}).success).toBe(false);
    expect(placeOrderSchema.safeParse({ tableNumber: "  ", phone: "" }).success).toBe(false);
    expect(placeOrderSchema.safeParse({ note: "no onion" }).success).toBe(false);
  });

  test("a bad phone is refused even with a table", () => {
    expect(placeOrderSchema.safeParse({ tableNumber: "4", phone: "12345" }).success).toBe(false);
  });

  test("a table number cannot carry markup", () => {
    expect(placeOrderSchema.safeParse({ tableNumber: "<script>" }).success).toBe(false);
    expect(placeOrderSchema.safeParse({ tableNumber: "Terrace 4" }).success).toBe(true);
  });
});

describe("orderDecisionSchema", () => {
  test("only accept or reject", () => {
    expect(orderDecisionSchema.safeParse({ status: "accepted" }).success).toBe(true);
    expect(orderDecisionSchema.safeParse({ status: "pending" }).success).toBe(false);
    expect(orderDecisionSchema.safeParse({ status: "cancelled" }).success).toBe(false);
  });
});
