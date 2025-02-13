/**
 * Copyright (c) 2019-2021 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */

import { V1ClusterRole, V1ClusterRoleBinding, V1Deployment, V1Role, V1RoleBinding } from '@kubernetes/client-node'
import { Command } from '@oclif/command'
import { cli } from 'cli-ux'
import * as fs from 'fs'
import * as Listr from 'listr'
import * as path from 'path'
import { ChectlContext } from '../../api/context'
import { KubeHelper } from '../../api/kube'
import { VersionHelper } from '../../api/version'
import { CHE_CLUSTER_API_GROUP, CHE_CLUSTER_API_VERSION, CHE_CLUSTER_CRD, CHE_CLUSTER_KIND_PLURAL, CHE_OPERATOR_SELECTOR, OPERATOR_DEPLOYMENT_NAME, OPERATOR_TEMPLATE_DIR } from '../../constants'
import { getImageNameAndTag, safeLoadFromYamlFile } from '../../util'
import { KubeTasks } from '../kube'
import { isDevWorkspaceEnabled } from '../../util'
import { createEclipseCheCluster, patchingEclipseCheCluster } from './common-tasks'

export class OperatorTasks {
  operatorServiceAccount = 'che-operator'

  legacyClusterResourcesName = 'che-operator'

  devworkspaceCheNamePrefix = 'devworkspace-che'

  private getReadRolesAndBindingsTask(kube: KubeHelper): Listr.ListrTask {
    return {
      title: 'Read Roles and Bindings',
      task: async (ctx: any, task: any) => {
        ctx.roles = []
        ctx.roleBindings = []
        ctx.clusterRoles = []
        ctx.clusterRoleBindings = []
        const filesList = fs.readdirSync(ctx.resourcesPath)
        for (const fileName of filesList) {
          if (!fileName.endsWith('.yaml')) {
            continue
          }
          const yamlFilePath = path.join(ctx.resourcesPath, fileName)
          const yamlContent = kube.safeLoadFromYamlFile(yamlFilePath)
          if (!(yamlContent && yamlContent.kind)) {
            continue
          }
          switch (yamlContent.kind) {
          case 'Role':
            ctx.roles.push(yamlContent)
            break
          case 'RoleBinding':
            ctx.roleBindings.push(yamlContent)
            break
          case 'ClusterRole':
            ctx.clusterRoles.push(yamlContent)
            break
          case 'ClusterRoleBinding':
            ctx.clusterRoleBindings.push(yamlContent)
            break
          default:
            // Ignore this object kind
          }
        }

        // Check consistancy
        if (ctx.roles.length !== ctx.roleBindings.length) {
          cli.warn('Number of Roles and Role Bindings is different')
        }
        if (ctx.clusterRoles.length !== ctx.clusterRoleBindings.length) {
          cli.warn('Number of Cluster Roles and Cluster Role Bindings is different')
        }

        task.title = `${task.title}...done.`
      },
    }
  }

  private getCreateOrUpdateRolesAndBindingsTask(flags: any, taskTitle: string, shouldUpdate = false): Listr.ListrTask {
    const kube = new KubeHelper(flags)
    return {
      title: taskTitle,
      task: async (ctx: any, task: any) => {
        if (!ctx.roles) {
          // Should never happen. 'Read Roles and Bindings' task should be called first.
          throw new Error('Should read Roles and Bindings first')
        }

        for (const role of ctx.roles as V1Role[]) {
          if (await kube.isRoleExist(role.metadata!.name, flags.chenamespace)) {
            if (shouldUpdate) {
              await kube.replaceRoleFromObj(role, flags.chenamespace)
            }
          } else {
            await kube.createRoleFromObj(role, flags.chenamespace)
          }
        }

        for (const roleBinding of ctx.roleBindings as V1RoleBinding[]) {
          if (await kube.isRoleBindingExist(roleBinding.metadata!.name, flags.chenamespace)) {
            if (shouldUpdate) {
              await kube.replaceRoleBindingFromObj(roleBinding, flags.chenamespace)
            }
          } else {
            await kube.createRoleBindingFromObj(roleBinding, flags.chenamespace)
          }
        }

        // For Cluster Roles and Cluster Role Bindings use prefix to allow several Che installations
        const clusterObjectNamePrefix = `${flags.chenamespace}-`

        for (const clusterRole of ctx.clusterRoles as V1ClusterRole[]) {
          const clusterRoleName = clusterObjectNamePrefix + clusterRole.metadata!.name
          if (await kube.isClusterRoleExist(clusterRoleName)) {
            if (shouldUpdate) {
              await kube.replaceClusterRoleFromObj(clusterRole, clusterRoleName)
            }
          } else {
            await kube.createClusterRoleFromObj(clusterRole, clusterRoleName)
          }
        }

        for (const clusterRoleBinding of ctx.clusterRoleBindings as V1ClusterRoleBinding[]) {
          clusterRoleBinding.metadata!.name = clusterObjectNamePrefix + clusterRoleBinding.metadata!.name
          clusterRoleBinding.roleRef.name = clusterObjectNamePrefix + clusterRoleBinding.roleRef.name
          for (const subj of clusterRoleBinding.subjects || []) {
            subj.namespace = flags.chenamespace
          }
          if (await kube.isClusterRoleBindingExist(clusterRoleBinding.metadata!.name)) {
            if (shouldUpdate) {
              await kube.replaceClusterRoleBindingFromObj(clusterRoleBinding)
            }
          } else {
            await kube.createClusterRoleBindingFromObj(clusterRoleBinding)
          }
        }

        task.title = `${task.title}...done.`
      },
    }
  }

  /**
   * Returns tasks list which perform preflight platform checks.
   */
  async deployTasks(flags: any, command: Command): Promise<Listr.ListrTask[]> {
    const kube = new KubeHelper(flags)
    const kubeTasks = new KubeTasks(flags)
    const ctx = ChectlContext.get()
    ctx.resourcesPath = path.join(flags.templates, OPERATOR_TEMPLATE_DIR)
    if (VersionHelper.isDeployingStableVersion(flags) && !await kube.isOpenShift3()) {
      command.warn('Consider using the more reliable \'OLM\' installer when deploying a stable release of Eclipse Che (--installer=olm).')
    }
    return [
      {
        title: `Create ServiceAccount ${this.operatorServiceAccount} in namespace ${flags.chenamespace}`,
        task: async (ctx: any, task: any) => {
          const exist = await kube.isServiceAccountExist(this.operatorServiceAccount, flags.chenamespace)
          if (exist) {
            task.title = `${task.title}...It already exists.`
          } else {
            const yamlFilePath = path.join(ctx.resourcesPath, 'service_account.yaml')
            await kube.createServiceAccountFromFile(yamlFilePath, flags.chenamespace)
            task.title = `${task.title}...done.`
          }
        },
      },
      this.getReadRolesAndBindingsTask(kube),
      this.getCreateOrUpdateRolesAndBindingsTask(flags, 'Creating Roles and Bindings', false),
      {
        title: `Create CRD ${CHE_CLUSTER_CRD}`,
        task: async (ctx: any, task: any) => {
          const existedCRD = await kube.getCrd(CHE_CLUSTER_CRD)
          if (existedCRD) {
            task.title = `${task.title}...It already exists.`
          } else {
            const newCRDPath = await this.getCRDPath(ctx, flags)
            await kube.createCrdFromFile(newCRDPath)
            task.title = `${task.title}...done.`
          }
        },
      },
      {
        title: 'Waiting 5 seconds for the new Kubernetes resources to get flushed',
        task: async (_ctx: any, task: any) => {
          await cli.wait(5000)
          task.title = `${task.title}...done.`
        },
      },
      {
        title: `Create deployment ${OPERATOR_DEPLOYMENT_NAME} in namespace ${flags.chenamespace}`,
        task: async (ctx: any, task: any) => {
          const exist = await kube.isDeploymentExist(OPERATOR_DEPLOYMENT_NAME, flags.chenamespace)
          if (exist) {
            task.title = `${task.title}...It already exists.`
          } else {
            const deploymentPath = path.join(ctx.resourcesPath, 'operator.yaml')
            const operatorDeployment = await this.readOperatorDeployment(deploymentPath, flags)
            await kube.createDeploymentFromObj(operatorDeployment, flags.chenamespace)
            task.title = `${task.title}...done.`
          }
        },
      },
      {
        title: 'Operator pod bootstrap',
        task: () => kubeTasks.podStartTasks(CHE_OPERATOR_SELECTOR, flags.chenamespace),
      },
      {
        title: 'Prepare Eclipse Che cluster CR',
        task: async (ctx: any, task: any) => {
          const cheCluster = await kube.getCheCluster(flags.chenamespace)
          if (cheCluster) {
            task.title = `${task.title}...It already exists..`
            return
          }

          if (!ctx.customCR) {
            const yamlFilePath = path.join(ctx.resourcesPath, 'crds', 'org_v1_che_cr.yaml')
            ctx.defaultCR = safeLoadFromYamlFile(yamlFilePath)
          }

          task.title = `${task.title}...Done.`
        },
      },
      createEclipseCheCluster(flags, kube),
    ]
  }

  preUpdateTasks(flags: any, command: Command): Listr {
    const kube = new KubeHelper(flags)
    const ctx = ChectlContext.get()
    ctx.resourcesPath = path.join(flags.templates, OPERATOR_TEMPLATE_DIR)
    return new Listr([
      {
        title: 'Checking existing operator deployment before update',
        task: async (ctx: any, task: any) => {
          const operatorDeployment = await kube.getDeployment(OPERATOR_DEPLOYMENT_NAME, flags.chenamespace)
          if (!operatorDeployment) {
            command.error(`${OPERATOR_DEPLOYMENT_NAME} deployment is not found in namespace ${flags.chenamespace}.\nProbably Eclipse Che was initially deployed with another installer`)
          }
          ctx.deployedCheOperatorYaml = operatorDeployment
          task.title = `${task.title}...done`
        },
      },
      {
        title: 'Detecting existing version...',
        task: async (ctx: any, task: any) => {
          ctx.deployedCheOperatorImage = this.retrieveContainerImage(ctx.deployedCheOperatorYaml)
          const [deployedImage, deployedTag] = getImageNameAndTag(ctx.deployedCheOperatorImage)
          ctx.deployedCheOperatorImageName = deployedImage
          ctx.deployedCheOperatorImageTag = deployedTag

          if (flags['che-operator-image']) {
            ctx.newCheOperatorImage = flags['che-operator-image']
          } else {
            // Load new operator image from templates
            const newCheOperatorYaml = safeLoadFromYamlFile(path.join(flags.templates, OPERATOR_TEMPLATE_DIR, 'operator.yaml')) as V1Deployment
            ctx.newCheOperatorImage = this.retrieveContainerImage(newCheOperatorYaml)
          }
          const [newImage, newTag] = getImageNameAndTag(ctx.newCheOperatorImage)
          ctx.newCheOperatorImageName = newImage
          ctx.newCheOperatorImageTag = newTag

          task.title = `${task.title} ${ctx.deployedCheOperatorImageTag} -> ${ctx.newCheOperatorImageTag}`
        },
      },
      {
        title: 'Check workspace engine compatibility...',
        task: async (_ctx: any, _task: any) => {
          const cheCluster = await kube.getCheCluster(flags.chenamespace)

          if (cheCluster) {
            const isDevWorkspaceEngineEnabledBeforeUpdate = cheCluster.spec.devWorkspace && cheCluster.spec.devWorkspace.enable
            const isDevWorkspaceEngineEnabledAfterUpdate = isDevWorkspaceEnabled(ctx)

            if (!isDevWorkspaceEngineEnabledBeforeUpdate && isDevWorkspaceEngineEnabledAfterUpdate) {
              command.error('Unsupported operation: it is not possible to update current Che installation to new version with enabled \'devWorkspace\' engine.')
            }
          }
        },
      },
    ])
  }

  updateTasks(flags: any, command: Command): Array<Listr.ListrTask> {
    const kube = new KubeHelper(flags)
    const ctx = ChectlContext.get()
    ctx.resourcesPath = path.join(flags.templates, OPERATOR_TEMPLATE_DIR)
    return [
      {
        title: `Updating ServiceAccount ${this.operatorServiceAccount} in namespace ${flags.chenamespace}`,
        task: async (ctx: any, task: any) => {
          const exist = await kube.isServiceAccountExist(this.operatorServiceAccount, flags.chenamespace)
          const yamlFilePath = path.join(ctx.resourcesPath, 'service_account.yaml')
          if (exist) {
            await kube.replaceServiceAccountFromFile(yamlFilePath, flags.chenamespace)
            task.title = `${task.title}...updated.`
          } else {
            await kube.createServiceAccountFromFile(yamlFilePath, flags.chenamespace)
            task.title = `${task.title}...created new one.`
          }
        },
      },
      this.getReadRolesAndBindingsTask(kube),
      this.getCreateOrUpdateRolesAndBindingsTask(flags, 'Updating Roles and Bindings', true),
      {
        title: `Updating Eclipse Che cluster CRD ${CHE_CLUSTER_CRD}`,
        task: async (ctx: any, task: any) => {
          const existedCRD = await kube.getCrd(CHE_CLUSTER_CRD)
          const newCRDPath = await this.getCRDPath(ctx, flags)

          if (existedCRD) {
            if (!existedCRD.metadata || !existedCRD.metadata.resourceVersion) {
              throw new Error(`Fetched CRD ${CHE_CLUSTER_CRD} without resource version`)
            }

            await kube.replaceCrdFromFile(newCRDPath, existedCRD.metadata.resourceVersion)
            task.title = `${task.title}...updated.`
          } else {
            await kube.createCrdFromFile(newCRDPath)
            task.title = `${task.title}...created new one.`
          }
        },
      },
      {
        title: 'Waiting 5 seconds for the new Kubernetes resources to get flushed',
        task: async (_ctx: any, task: any) => {
          await cli.wait(5000)
          task.title = `${task.title}...done.`
        },
      },
      {
        title: `Updating deployment ${OPERATOR_DEPLOYMENT_NAME} in namespace ${flags.chenamespace}`,
        task: async (ctx: any, task: any) => {
          const exist = await kube.isDeploymentExist(OPERATOR_DEPLOYMENT_NAME, flags.chenamespace)
          const deploymentPath = path.join(ctx.resourcesPath, 'operator.yaml')
          const operatorDeployment = await this.readOperatorDeployment(deploymentPath, flags)
          if (exist) {
            await kube.replaceDeploymentFromObj(operatorDeployment)
            task.title = `${task.title}...updated.`
          } else {
            await kube.createDeploymentFromObj(operatorDeployment, flags.chenamespace)
            task.title = `${task.title}...created new one.`
          }
        },
      },
      {
        title: 'Waiting newer operator to be run',
        task: async (_ctx: any, _task: any) => {
          await cli.wait(1000)
          await kube.waitLatestReplica(OPERATOR_DEPLOYMENT_NAME, flags.chenamespace)
        },
      },
      patchingEclipseCheCluster(flags, kube, command),
    ]
  }

  /**
   * Returns list of tasks which remove Eclipse Che operator related resources
   */
  deleteTasks(flags: any): ReadonlyArray<Listr.ListrTask> {
    const kh = new KubeHelper(flags)
    return [{
      title: 'Delete oauthClientAuthorizations',
      task: async (_ctx: any, task: any) => {
        const checluster = await kh.getCheCluster(flags.chenamespace)
        if (checluster && checluster.spec && checluster.spec.auth && checluster.spec.auth.oAuthClientName) {
          const oAuthClientAuthorizations = await kh.getOAuthClientAuthorizations(checluster.spec.auth.oAuthClientName)
          await kh.deleteOAuthClientAuthorizations(oAuthClientAuthorizations)
        }
        task.title = `${task.title}...OK`
      },
    },
    {
      title: `Delete the Custom Resource of type ${CHE_CLUSTER_CRD}`,
      task: async (_ctx: any, task: any) => {
        await kh.deleteCheCluster(flags.chenamespace)

        // wait 20 seconds, default timeout in che operator
        for (let index = 0; index < 20; index++) {
          await cli.wait(1000)
          if (!await kh.getCheCluster(flags.chenamespace)) {
            task.title = `${task.title}...OK`
            return
          }
        }

        // if checluster still exists then remove finalizers and delete again
        const checluster = await kh.getCheCluster(flags.chenamespace)
        if (checluster) {
          try {
            await kh.patchCustomResource(checluster.metadata.name, flags.chenamespace, { metadata: { finalizers: null } }, CHE_CLUSTER_API_GROUP, CHE_CLUSTER_API_VERSION, CHE_CLUSTER_KIND_PLURAL)
          } catch (error) {
            if (!await kh.getCheCluster(flags.chenamespace)) {
              task.title = `${task.title}...OK`
              return // successfully removed
            }
            throw error
          }

          // wait 2 seconds
          await cli.wait(2000)
        }

        if (!await kh.getCheCluster(flags.chenamespace)) {
          task.title = `${task.title}...OK`
        } else {
          task.title = `${task.title}...Failed`
        }
      },
    },
    {
      title: 'Delete CRDs',
      task: async (_ctx: any, task: any) => {
        const checlusters = await kh.getAllCheClusters()
        if (checlusters.length > 0) {
          task.title = `${task.title}...Skipped: another Eclipse Che deployment found.`
        } else {
          await kh.deleteCrd(CHE_CLUSTER_CRD)
          task.title = `${task.title}...OK`
        }
      },
    },
    {
      title: 'Delete Roles and Bindings',
      task: async (_ctx: any, task: any) => {
        const roleBindings = await kh.listRoleBindings(flags.chenamespace)
        for (const roleBinding of roleBindings.items) {
          await kh.deleteRoleBinding(roleBinding.metadata!.name!, flags.chenamespace)
        }

        const roles = await kh.listRoles(flags.chenamespace)
        for (const role of roles.items) {
          await kh.deleteRole(role.metadata!.name!, flags.chenamespace)
        }

        // Count existing pairs of cluster roles and thier bindings
        let pairs = 0

        const clusterRoleBindings = await kh.listClusterRoleBindings()
        for (const clusterRoleBinding of clusterRoleBindings.items) {
          const name = clusterRoleBinding.metadata && clusterRoleBinding.metadata.name || ''
          if (name.startsWith(flags.chenamespace) || name.startsWith(this.devworkspaceCheNamePrefix)) {
            pairs++
            await kh.deleteClusterRoleBinding(name)
          }
        }

        const clusterRoles = await kh.listClusterRoles()
        for (const clusterRole of clusterRoles.items) {
          const name = clusterRole.metadata && clusterRole.metadata.name || ''
          if (name.startsWith(flags.chenamespace) || name.startsWith(this.devworkspaceCheNamePrefix)) {
            await kh.deleteClusterRole(name)
          }
        }

        // If no pairs were deleted, then legacy names is used
        if (pairs === 0) {
          await kh.deleteClusterRoleBinding(this.legacyClusterResourcesName)
          await kh.deleteClusterRole(this.legacyClusterResourcesName)
        }

        task.title = `${task.title}...OK`
      },
    },
    {
      title: `Delete service accounts ${this.operatorServiceAccount}`,
      task: async (_ctx: any, task: any) => {
        await kh.deleteServiceAccount(this.operatorServiceAccount, flags.chenamespace)
        task.title = `${task.title}...OK`
      },
    },
    {
      title: 'Delete PVC che-operator',
      task: async (_ctx: any, task: any) => {
        await kh.deletePersistentVolumeClaim('che-operator', flags.chenamespace)
        task.title = `${task.title}...OK`
      },
    }]
  }

  retrieveContainerImage(deployment: V1Deployment) {
    const containers = deployment.spec!.template!.spec!.containers
    const namespace = deployment.metadata!.namespace
    const name = deployment.metadata!.name
    const container = containers.find(c => c.name === 'che-operator')

    if (!container) {
      throw new Error(`Can not evaluate image of ${namespace}/${name} deployment. Containers list are empty`)
    }
    if (!container.image) {
      throw new Error(`Container ${container.name} in deployment ${namespace}/${name} must have image specified`)
    }

    return container.image
  }

  async getCRDPath(ctx: any, flags: any): Promise<string> {
    let newCRDFilePath: string

    const kube = new KubeHelper(flags)
    if (!await kube.IsAPIExtensionSupported('v1')) {
      // try to get CRD v1beta1 if platform doesn't support v1
      newCRDFilePath = path.join(ctx.resourcesPath, 'crds', 'org_v1_che_crd-v1beta1.yaml')
      if (fs.existsSync(newCRDFilePath)) {
        return newCRDFilePath
      }
    }

    return path.join(ctx.resourcesPath, 'crds', 'org_v1_che_crd.yaml')
  }

  /**
   * Reads and patch 'che-operator' deployment:
   * - sets operator image
   * - sets deployment namespace
   * - removes other containers for ocp 3.11
   */
  private async readOperatorDeployment(path: string, flags: any): Promise<V1Deployment> {
    const operatorDeployment = safeLoadFromYamlFile(path) as V1Deployment

    if (!operatorDeployment.metadata || !operatorDeployment.metadata!.name) {
      throw new Error(`Deployment read from ${path} must have name specified`)
    }

    if (flags['che-operator-image']) {
      const container = operatorDeployment.spec!.template.spec!.containers.find(c => c.name === 'che-operator')
      if (container) {
        container.image = flags['che-operator-image']
      } else {
        throw new Error(`Container 'che-operator' not found in deployment '${operatorDeployment.metadata!.name}'`)
      }
    }

    if (flags.chenamespace) {
      operatorDeployment.metadata!.namespace = flags.chenamespace
    }

    const kube = new KubeHelper(flags)
    if (!await kube.IsAPIExtensionSupported('v1')) {
      const containers = operatorDeployment.spec!.template.spec!.containers || []
      operatorDeployment.spec!.template.spec!.containers = containers.filter(c => c.name === 'che-operator')
    }

    return operatorDeployment
  }
}
