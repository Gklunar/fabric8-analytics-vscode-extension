'use strict';

import * as fs from 'fs';
import * as vscode from 'vscode';

import { globalConfig } from './config';
import { imageAnalysisService } from './exhortServices';
import { StatusMessages, Titles } from './constants';
import { updateCurrentWebviewPanel } from './rhda';

interface IOptions {
    RHDA_TOKEN: string;
    RHDA_SOURCE: string;
    EXHORT_SYFT_PATH: string;
    EXHORT_SYFT_CONFIG_PATH: string;
    EXHORT_SYFT_IMAGE_SOURCE: string;
    EXHORT_SKOPEO_PATH: string;
    EXHORT_SKOPEO_CONFIG_PATH: string;
    EXHORT_IMAGE_SERVICE_ENDPOINT: string;
    EXHORT_DOCKER_PATH: string;
    EXHORT_PODMAN_PATH: string;
    EXHORT_IMAGE_PLATFORM: string;
    EXHORT_IMAGE_OS: string;
    EXHORT_IMAGE_ARCH: string;
    EXHORT_IMAGE_VARIANT: string;
}

interface IImageRef {
    image: string;
    platform: string;
}

/**
 * Represents data specification related to a dependency.
 */
interface IImageAnalysis {
    options: IOptions;
    args: Map<string, string>;
    images: IImageRef[];
    imageAnalysisReportHtml: string;

    parseTxtDoc(filePath: string): string[];
    collectImages(lines: string[]): IImageRef[];
    runImageAnalysis(): Promise<void>;
}

/**
 * Implementation of IImageAnalysis interface.
 */
class DockerImageAnalysis implements IImageAnalysis {
    options: IOptions = {
        'RHDA_TOKEN': globalConfig.telemetryId,
        'RHDA_SOURCE': globalConfig.utmSource,
        'EXHORT_SYFT_PATH': globalConfig.exhortSyftPath,
        'EXHORT_SYFT_CONFIG_PATH': globalConfig.exhortSyftConfigPath,
        'EXHORT_SYFT_IMAGE_SOURCE': globalConfig.exhortSyftImageSource,
        'EXHORT_SKOPEO_PATH': globalConfig.exhortSkopeoPath,
        'EXHORT_SKOPEO_CONFIG_PATH': globalConfig.exhortSkopeoConfigPath,
        'EXHORT_IMAGE_SERVICE_ENDPOINT': globalConfig.exhortImageServiceEndpoint,
        'EXHORT_DOCKER_PATH': globalConfig.exhortDockerPath,
        'EXHORT_PODMAN_PATH': globalConfig.exhortPodmanPath,
        'EXHORT_IMAGE_PLATFORM': globalConfig.exhortImagePlatform,
        'EXHORT_IMAGE_OS': globalConfig.exhortImageOS,
        'EXHORT_IMAGE_ARCH': globalConfig.exhortImageArch,
        'EXHORT_IMAGE_VARIANT': globalConfig.exhortImageVariant
    };
    args: Map<string, string> = new Map<string, string>();
    images: IImageRef[] = [];
    imageAnalysisReportHtml: string = '';

    FROM_REGEX: RegExp = /^\s*FROM\s+(.*)/;
    ARG_REGEX: RegExp = /^\s*ARG\s+(.*)/;
    PLATFORM_REGEX: RegExp = /--platform=([^\s]+)/g;
    AS_REGEX: RegExp = /\s+AS\s+\S+/gi;

    constructor(filePath: string) {
        const lines = this.parseTxtDoc(filePath);

        this.images = this.collectImages(lines);
    }

    /**
     * Parses the provided string as an array of lines.
     * @param contents - The string content to parse into lines.
     * @returns An array of strings representing lines from the provided content.
     */
    parseTxtDoc(filePath: string): string[] {
        try {
            const contentBuffer = fs.readFileSync(filePath);

            const contentString = contentBuffer.toString('utf-8');

            return contentString.split('\n');
        } catch (err) {
            updateCurrentWebviewPanel('error');
            throw (err);
        }
    }

    private replaceArgsInString(imageData: string): string {
        return imageData.replace(/\${([^{}]+)}/g, (match, key) => {
            const value = this.args.get(key) || '';
            return value;
        });
    }

    /**
     * Parses a line from the file and extracts dependency information.
     * @param line - The line to parse for dependency information.
     * @param index - The index of the line in the file.
     * @returns An IDependency object representing the parsed dependency or null if no dependency is found.
     */
    private parseLine(line: string): IImageRef | null {
        const argMatch = line.match(this.ARG_REGEX);
        if (argMatch) {
            const argData = argMatch[1].trim().split('=');
            this.args.set(argData[0], argData[1]);
        }

        const imageMatch = line.match(this.FROM_REGEX);
        if (imageMatch) {
            let imageData = imageMatch[1];
            imageData = this.replaceArgsInString(imageData);
            imageData = imageData.replace(this.PLATFORM_REGEX, '');
            imageData = imageData.replace(this.AS_REGEX, '');
            imageData = imageData.trim();

            if (imageData === 'scratch') {
                return;
            }

            let platformData = '';
            const platformMatch = line.match(this.PLATFORM_REGEX);
            if (platformMatch) {
                platformData = platformMatch[0].split('=')[1];
            }

            return { image: imageData, platform: platformData };
        }
        return;
    }

    /**
     * Extracts dependencies from lines parsed from the file.
     * @param lines - An array of strings representing lines from the file.
     * @returns An array of IDependency objects representing extracted dependencies.
     */
    collectImages(lines: string[]): IImageRef[] {
        return lines.reduce((images: IImageRef[], line: string) => {
            const parsedImage = this.parseLine(line);
            if (parsedImage) {
                images.push(parsedImage);
            }
            return images;
        }, []);
    }

    async runImageAnalysis() {
        try {
            return await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: Titles.EXT_TITLE }, async p => {
                return new Promise<void>(async (resolve, reject) => {
                    p.report({
                        message: StatusMessages.WIN_ANALYZING_DEPENDENCIES
                    });

                    // execute image analysis
                    await imageAnalysisService(this.images, this.options)
                        .then(async (resp) => {
                            p.report({
                                message: StatusMessages.WIN_GENERATING_DEPENDENCIES
                            });

                            updateCurrentWebviewPanel(resp);

                            p.report({
                                message: StatusMessages.WIN_SUCCESS_DEPENDENCY_ANALYSIS
                            });

                            this.imageAnalysisReportHtml = resp;

                            resolve();
                        })
                        .catch(err => {
                            p.report({
                                message: StatusMessages.WIN_FAILURE_DEPENDENCY_ANALYSIS
                            });

                            reject(err);
                        });
                });
            });
        } catch (err) {
            updateCurrentWebviewPanel('error');
            throw (err);
        }
    }
}

/**
 * Performs RHDA component analysis on provided manifest contents and fileType based on ecosystem.
 * @param filePath - The path to the manifest file to analyze.
 * @returns A Promise resolving to an Analysis Report HTML.
 */
async function executeDockerImageAnalysis(filePath: string): Promise<string> {
    try {
        const dockerImageAnalysis = new DockerImageAnalysis(filePath);
        await dockerImageAnalysis.runImageAnalysis();
        return dockerImageAnalysis.imageAnalysisReportHtml;
    } catch (error) {
        throw (error);
    }
}

export { executeDockerImageAnalysis, IImageRef, IOptions };