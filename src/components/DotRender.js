import React from "react";
import { Unity, useUnityContext } from "react-unity-webgl";

function DotRender() {
  const { unityProvider } = useUnityContext({
    loaderUrl: "build/DotRenderV2C.loader.js",
    dataUrl: "build/DotRenderV2C.data",
    frameworkUrl: "build/DotRenderV2C.framework.js",
    codeUrl: "build/DotRenderV2C.wasm",
  });

  return <Unity unityProvider={unityProvider} />;
}

export default DotRender;