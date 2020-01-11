/*********************************************************************
 * Copyright (c) 2020 Red Hat, Inc.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 **********************************************************************/

import * as Listr from 'listr'
import * as path from 'path'

import { KubeHelper } from '../../api/kube'
import { CERT_MANAGER_NAMESPACE_NAME } from '../../constants'

const RESOURCES_FOLDER_PATH = '../../../resources'

export const CERT_MANAGER_CA_SECRET_NAME = 'ca'

export class CertManagerTasks {
  protected kubeHelper: KubeHelper

  constructor(flags: any) {
    this.kubeHelper = new KubeHelper(flags)
  }

  /**
   * Returns list of tasks which perform cert-manager checks and deploy.
   */
  deployTasks(flags: any): ReadonlyArray<Listr.ListrTask> {
    return [
      {
        title: 'Check Cert Manager installation',
        task: async (ctx: any, task: any) => {
          // Check only one CRD of cert-manager assuming that it is installed or not.
          const exists: boolean = await this.kubeHelper.crdExist('certificates.cert-manager.io')
          ctx.certManagerInstalled = exists
          if (exists) {
            task.title = `${task.title}...installed`
          } else {
            task.title = `${task.title}...not installed`

            return new Listr([
              {
                title: 'Deploy cert-manager',
                task: async (ctx: any) => {
                  const yamlPath = path.join(flags.resources, '/cert-manager/cert-manager.yml')
                  await this.kubeHelper.applyResource(yamlPath)
                  ctx.certManagerInstalled = true
                }
              }
            ])
          }
        }
      },
      {
        title: 'Check Cert Manager configuration',
        task: async (ctx: any, task: any) => {
          if (!ctx.certManagerInstalled) {
            throw new Error('Cert manager must be installed before.')
          }
          // To be able to use self-signed sertificate it is required to provide CA private key & certificate to cert-manager
          const caSelfSignedCertSecret = await this.kubeHelper.getSecret(CERT_MANAGER_CA_SECRET_NAME, CERT_MANAGER_NAMESPACE_NAME)
          if (!caSelfSignedCertSecret) {
            // First run, generate CA self-signed certificate

            task.title = `${task.title}...generating Cert Manager CA certificate`

            // Configure permissions for CA key pair generation job
            await this.kubeHelper.createServiceAccount('ca-cert-generator', CERT_MANAGER_NAMESPACE_NAME)
            await this.kubeHelper.createRoleFromFile(path.join(RESOURCES_FOLDER_PATH, 'cert-manager', 'ca-cert-generator-role.yml'), CERT_MANAGER_NAMESPACE_NAME)
            await this.kubeHelper.createRoleBindingFromFile(path.join(RESOURCES_FOLDER_PATH, 'cert-manager', 'ca-cert-generator-role-binding.yml'), CERT_MANAGER_NAMESPACE_NAME)
            // Run CA key pair generation job
            await this.kubeHelper.createJob('ca-cert-generation-job', 'mm4eche/che-cert-manager-ca-cert-generator:latest', 'ca-cert-generator', 'IfNotPresent', CERT_MANAGER_NAMESPACE_NAME)
            // TODO !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! await job finished
            // Clean up resources
            await this.kubeHelper.deleteRoleBinding('ca-cert-generator-role-binding.yml', CERT_MANAGER_NAMESPACE_NAME)
            await this.kubeHelper.deleteRole('ca-cert-generator-role.yml', CERT_MANAGER_NAMESPACE_NAME)
            await this.kubeHelper.deleteServiceAccount('ca-cert-generator', CERT_MANAGER_NAMESPACE_NAME)
          } else {
            task.title = `${task.title}...already exists`
          }
        }
      },
      {
        title: 'Set up certificates issuer',
        task: async (_ctx: any, task: any) => {
          const issuerExists = false
          // TODO check it
          if (!issuerExists) {
            const certificateTemplatePath = path.join(flags.resources, '/cert-manager/che-certificate.yml')
            await this.kubeHelper.createCheClusterCertificate(certificateTemplatePath, flags.domain)

            task.title = `${task.title}...done`
          } else {
            task.title = `${task.title}...already exists`
          }
        }
      }
    ]
  }

}
