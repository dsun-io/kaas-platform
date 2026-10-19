// @ts-check
import { module } from "@prisma/composer";
import kaasFrontendService from "./frontend/service.mjs";

export default module("kaas-frontend", ({ provision }) => {
  provision(kaasFrontendService, { id: "kaasfrontend" });
});
