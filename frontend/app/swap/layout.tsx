import { LaunchGradientBody } from "../../components/launch/launch-gradient-body";

export default function SwapLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <LaunchGradientBody />
      {children}
    </>
  );
}
