declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.yaml" {
  const text: string;
  export default text;
}
