declare module '*.nexus' {
  const component: (props: Record<string, unknown>) => Node;
  export default component;
}
