import { LaunchGradientBody } from "../../components/launch/launch-gradient-body";

export default function StakesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <LaunchGradientBody />
      {children}
    </>
  );
}
