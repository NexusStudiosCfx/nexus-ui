/// <reference types="vite/client" />

// Lets a .ts module import a component, and an editor resolve it. `nexus check` knows each
// component's own props. This is the fallback for tools that do not read .nexus files.
declare module '*.nexus' {
  const component: (props: Record<string, any>) => Node;
  export default component;
}
