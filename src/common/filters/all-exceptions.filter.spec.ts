import { BadRequestException, HttpStatus } from "@nestjs/common";
import { AllExceptionsFilter } from "./all-exceptions.filter";

function createHost(user?: { id: string }) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const request = { method: "GET", originalUrl: "/test", user };
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => request,
    }),
  } as unknown as Parameters<AllExceptionsFilter["catch"]>[1];

  return { host, status, json };
}

describe("AllExceptionsFilter", () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jest
      .spyOn(filter["logger"], "warn")
      .mockImplementation(() => undefined as never);
    jest
      .spyOn(filter["logger"], "error")
      .mockImplementation(() => undefined as never);
  });

  it("preserves status and body for known HTTP exceptions", () => {
    const { host, status, json } = createHost();

    filter.catch(new BadRequestException("Invalid input"), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: "Invalid input" }),
    );
  });

  it("returns a generic 500 for unexpected errors without leaking details", () => {
    const { host, status, json } = createHost();

    filter.catch(new Error("db exploded"), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      message: "Internal server error",
    });
  });
});
