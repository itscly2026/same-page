import { Container } from "@cloudflare/containers";

export class PdfRenderer extends Container {
  defaultPort = 8080;
  sleepAfter = "30s";
  enableInternet = false;
}
