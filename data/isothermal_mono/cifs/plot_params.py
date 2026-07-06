import glob as glob
import Dans_Diffraction as dif


from matplotlib import rc
plt.rcParams['font.family'] = 'DejaVu Sans'
plt.rcParams['mathtext.fontset'] = 'dejavusans'
plt.rcParams['lines.linewidth']= 1
plt.rcParams['axes.facecolor'] = 'w'


def cos_law(a,b,c) :
	theta = np.arccos( (a**2+b**2-c**2)/(2*a*b)  )
	theta = theta*180/np.pi
	return theta

u = np.array([1,0,0])
v = np.array([-1/2,np.sqrt(3)/2,0])
w = np.array([0,0,1])


fnames = glob.glob('./*.cif')
fnames.sort()

# global params
fig_l = 0.20
fig_r = 0.85
ms=4


col = plt.cm.coolwarm(np.arange(10)/9) 

T_all = []
a_all = []
b_all = []
c_all = []
alpha_all = []
beta_all = []
gamma_all = []

atom_pos_all = {}
atom_uiso_all = {}

Co1_pos = np.array([0.5,0.5,0])

for ii in np.arange(len(fnames)) :
	xtl = dif.Crystal(fnames[ii])
	a = xtl.Cell.a
	b = xtl.Cell.b
	c = xtl.Cell.c
	alpha = xtl.Cell.alpha
	beta = xtl.Cell.beta
	gamma = xtl.Cell.gamma
	a_all.append(a)
	b_all.append(b)
	c_all.append(c)
	alpha_all.append(alpha)
	beta_all.append(beta)
	gamma_all.append(gamma)
	label = fnames[ii].split('_')[-1].split('K')[0]
	T_all.append( np.float64(label) )
	
	# handling the atomic positions
	if ii==0 :
		atm_label = xtl.Atoms.get()[2]
		atm_pos = xtl.Atoms.get()[0]
		atm_uiso = xtl.Atoms.get()[-2]
		for jj in np.arange(len(atm_label)) :
			atom_pos_all[atm_label[jj]] = []
			atom_pos_all[atm_label[jj]].append(atm_pos[jj])
			atom_uiso_all[atm_label[jj]] = []
			atom_uiso_all[atm_label[jj]].append(atm_uiso[jj])

	else :
		atm_label = xtl.Atoms.get()[2]
		atm_pos = xtl.Atoms.get()[0]
		atm_uiso = xtl.Atoms.get()[-2]
		for jj in np.arange(len(atm_label)) :
			atom_pos_all[atm_label[jj]].append(atm_pos[jj])
			atom_uiso_all[atm_label[jj]].append(atm_uiso[jj])
		
			

a_all = np.array(a_all)
b_all = np.array(b_all)
c_all = np.array(c_all)
alpha_all = np.array(alpha_all)
beta_all = np.array(beta_all)
gamma_all = np.array(gamma_all)

#++++++++++++++++++++++++++++++++ lattice parameters
fig = plt.figure(figsize=(3.25/2,3.25*9/16))
#fig.set_size_inches(3.25,3.25*9/16)
fig.set_size_inches(3.25,3.25*27/64)
ax = fig.add_subplot(111)
ax.errorbar(T_all, (a_all/a_all[-1]),5E-4*a_all/a_all[-1],
		lw=0.0,
		marker='o',ms=ms,mew=0.8,mfc='w',
		capsize=2,elinewidth=0.5,
		label='a',
		color=col[0],alpha=1.0)
ax.errorbar(T_all, b_all/b_all[-1],5E-4*b_all/b_all[-1],
		lw=0.0,
		marker='o',ms=ms,mew=0.8,mfc='w',
		capsize=2,elinewidth=0.5,
		label='b',
		color=col[5],alpha=1.0)
ax.errorbar(T_all, c_all/c_all[-1],5E-4*c_all/c_all[-1],
		lw=0.0,
		marker='o',ms=ms,mew=0.8,mfc='w',
		capsize=2,elinewidth=0.5,
		label='c',
		color=col[-1],alpha=1.0)

#ax.set_ylabel(r'$\mathrm{\Delta}$ latt. param. ($\mathrm{\AA}$)',fontsize=10) # latt
ax.set_ylabel(r'$\mathrm{\Delta l /l_{0}}$',fontsize=10) # latt



#'''
### plot params
ax.tick_params(axis='both',which='major',labelsize=8)
ax.spines['left'].set_linewidth(0.5)
ax.spines['right'].set_linewidth(0.5)
ax.spines['bottom'].set_linewidth(0.5)
ax.spines['top'].set_linewidth(0.5)

ax.tick_params(which='both', labelsize=9,
		labelbottom=True, labeltop=False, labelleft=True, labelright=False,
		bottom=True, top=True, left=True, right=False, direction='in')
ax.set_xlabel(r'T (K)',fontsize=10)
#ax.set_ylabel(ylabs[idx_p],fontsize=10)


ax.legend(fontsize=7,frameon=False)

# large ROI
#ax.set_xlim([98,210])
ax.xaxis.set_major_locator(MultipleLocator(100))
ax.xaxis.set_minor_locator(MultipleLocator(50))
#ax.yaxis.set_major_locator(MultipleLocator(2))
#ax.yaxis.set_minor_locator(MultipleLocator(1))
#fig.subplots_adjust(left = 0.26,right = 0.99, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30)
#fig.subplots_adjust(left = 0.12,right = 0.99, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30) # latt
#fig.subplots_adjust(left = 0.15,right = 0.99, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30) # latt new
#fig.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30) # latt new
#fig.subplots_adjust(left = 0.32,right = 0.99, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30)
fig.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.28, top = 0.99,wspace =0.02,hspace = 0.30) # one column


#++++++++++++++++++++++++++++++++ bond length 

fig2 = plt.figure(figsize=(3.25/2,3.25*9/16))
#fig2.set_size_inches(3.25,3.25*9/16)
fig2.set_size_inches(3.25,3.25*27/64)
bx = fig2.add_subplot(111)
#bx.plot(T_all,1E3*(-1+Co_Sn1_all/Co_Sn1_all[-1]),
bx.errorbar(T_all,beta_all-120,1E-4*beta_all,
		lw=0.0,
		marker='o',ms=ms,mew=0.8,mfc='w',
		capsize=2,elinewidth=0.5,
		label='beta',
		color=col[0],alpha=1.0)
#bx.plot(T_all,1E3*(-1+Co_Sn2_all/Co_Sn2_all[-1]),
#bx.errorbar(T_all,1E3*(-1+Co_Sn2_all/Co_Sn2_all[-1]),2*(Co_Sn2_all/Co_Sn2_Co_all[-1]),
#		lw=0.0,
#		marker='o',ms=ms,mew=0.8,mfc='w',
#		capsize=2,elinewidth=0.5,
#		label='M-Sn2',
#		color=col[-1],alpha=1.0)

### plot params
bx.tick_params(axis='both',which='major',labelsize=8)
bx.spines['left'].set_linewidth(0.5)
bx.spines['right'].set_linewidth(0.5)
bx.spines['bottom'].set_linewidth(0.5)
bx.spines['top'].set_linewidth(0.5)

bx.tick_params(which='both', labelsize=9,
		labelbottom=True, labeltop=False, labelleft=True, labelright=False,
		bottom=True, top=True, left=True, right=False, direction='in')
bx.set_xlabel(r'T (K)',fontsize=10)
bx.set_ylabel(r'$\mathrm{\beta - \beta_{0}}$',fontsize=10) # latt
#ax.set_ylabel(ylabs[idx_p],fontsize=10)
#bx.set_xlim([98,210])
bx.xaxis.set_major_locator(MultipleLocator(100))
bx.xaxis.set_minor_locator(MultipleLocator(50))
#bx.yaxis.set_major_locator(MultipleLocator(2))
#bx.yaxis.set_minor_locator(MultipleLocator(1))
#fig2.subplots_adjust(left = 0.15,right = 0.99, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30) # latt
#fig2.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30) # latt new
fig2.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.28, top = 0.99,wspace =0.02,hspace = 0.30) # one column

bx.legend(fontsize=7,frameon=False)

#++++++++++++++++++++++++++++++++ bond angle
fig3 = plt.figure(figsize=(3.25/2,3.25*9/16))
#fig3.set_size_inches(3.25,3.25*9/16)
fig3.set_size_inches(3.25,3.25*27/64)
cx = fig3.add_subplot(111)
cx.plot(T_all,1E5*(-1+Co_Sn1_Co_all/Co_Sn1_Co_all[-1]),
#cx.errorbar(T_all,Co_Sn1_Co_all/Co_Sn1_Co_all[-1],5E-8*Co_Sn1_Co_all,
		lw=0.0,
		marker='o',ms=ms,mew=0.8,mfc='w',
		#capsize=2,elinewidth=0.5,
		label='M-Sn1-M',
		color=col[0],alpha=1.0)
#cx.plot(T_all,Co_Sn2_Co_all/Co_Sn2_Co_all[-1],
cx.errorbar(T_all,1E5*(-1+Co_Sn2_Co_all/Co_Sn2_Co_all[-1]),5E-3*Co_Sn2_Co_all,
		lw=0.0,
		marker='o',ms=ms,mew=0.8,mfc='w',
		capsize=2,elinewidth=0.5,
		label='M-Sn2-M',
		color=col[-1],alpha=1.0)

### plot params
cx.tick_params(axis='both',which='major',labelsize=8)
cx.spines['left'].set_linewidth(0.5)
cx.spines['right'].set_linewidth(0.5)
cx.spines['bottom'].set_linewidth(0.5)
cx.spines['top'].set_linewidth(0.5)

cx.tick_params(which='both', labelsize=9,
		labelbottom=True, labeltop=False, labelleft=True, labelright=False,
		bottom=True, top=True, left=True, right=True, direction='in')
cx.set_xlabel(r'T (K)',fontsize=10)
cx.set_ylabel(r'$\mathrm{\Delta \alpha / \alpha_{0}}$',fontsize=10) # latt
#ax.set_ylabel(ylabs[idx_p],fontsize=10)
cx.set_xlim([98,210])
cx.xaxis.set_major_locator(MultipleLocator(50))
cx.xaxis.set_minor_locator(MultipleLocator(10))
#cx.yaxis.set_major_locator(MultipleLocator(2))
#cx.yaxis.set_minor_locator(MultipleLocator(1))
#fig3.subplots_adjust(left = 0.15,right = 0.99, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30) # latt
#fig3.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30) # latt new
fig3.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.28, top = 0.99,wspace =0.02,hspace = 0.30) # one column

cx.legend(fontsize=7,frameon=False)



#++++++++++++++++++++++++++++++++ c/a
fig4 = plt.figure(figsize=(3.25/2,3.25*9/16))
#fig4.set_size_inches(3.25,3.25*9/16)
fig4.set_size_inches(3.25,3.25*27/64)
dx = fig4.add_subplot(111)
#dx.plot(T_all,1.0E4*(c_all/a_all)/(c_all[-1]/a_all[-1]),
dx.errorbar(T_all,1.0E4*(c_all/a_all)/(c_all[-1]/a_all[-1]),1.0E-1*(c_all/a_all)/(c_all[-1]/a_all[-1]),
		lw=0.8,ls='--',
		marker='o',ms=ms,mew=0.8,mfc='w',
		capsize=2,elinewidth=0.5,
		color='dimgrey',alpha=1.0)
dx.set_ylabel(r'$[c/a]/[c_{0}/a_{0}]$',fontsize=10)
dx.yaxis.set_label_position("right")

dx.set_xlim([98,210])
dx.yaxis.set_major_locator(MultipleLocator(0.5))
dx.yaxis.set_minor_locator(MultipleLocator(0.1))

dx.tick_params(which='both', labelsize=9,
		labelbottom=False, labeltop=False, labelleft=False, labelright=True,
		bottom=False, top=False, left=False, right=True, direction='in')
#fig4.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30) # latt new
fig4.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.28, top = 0.99,wspace =0.02,hspace = 0.30) # one column


#++++++++++++++++++++++++++++++++ M-Sn2/M-Sn1
fig5 = plt.figure(figsize=(3.25/2,3.25*9/16))
#fig5.set_size_inches(3.25,3.25*9/16)
fig5.set_size_inches(3.25,3.25*27/64)
ex = fig5.add_subplot(111)
#ex.plot(T_all,1E4*(-1.0075 + Co_Sn2_all/Co_Sn1_all),
ex.errorbar(T_all,1E4*(-1.0075 + Co_Sn2_all/Co_Sn1_all),5E-4*Co_Sn2_Co_all,
		#color='dimgrey',lw=1.0)
		lw=0.8,ls='--',
		marker='o',ms=ms,mew=0.8,mfc='w',
		capsize=2,elinewidth=0.5,
		color='dimgrey',alpha=1.0)
#ex.set_ylabel(r'$\mathrm{\Delta}[$d$\mathrm{_{M-Sn2}}$/d$\mathrm{_{M-Sn1}}$]',fontsize=10)
ex.set_ylabel(r'd$\mathrm{_{M-Sn2}}$/d$\mathrm{_{M-Sn1}}$',fontsize=10)
ex.yaxis.set_label_position("right")

ex.set_xlim([98,210])
ex.yaxis.set_major_locator(MultipleLocator(0.5))
ex.yaxis.set_minor_locator(MultipleLocator(0.1))

ex.tick_params(which='both', labelsize=9,
		labelbottom=False, labeltop=False, labelleft=False, labelright=True,
		bottom=False, top=False, left=False, right=True, direction='in')
#fig5.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30) # latt new
fig5.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.28, top = 0.99,wspace =0.02,hspace = 0.30) # one column


#++++++++++++++++++++++++++++++++ ADP Sn
fig6 = plt.figure(figsize=(3.25/2,3.25*9/16))
#fig5.set_size_inches(3.25,3.25*9/16)
fig6.set_size_inches(3.25,3.25*9/16)
fx = fig6.add_subplot(111)
#ex.plot(T_all,1E4*(-1.0075 + Co_Sn2_all/Co_Sn1_all),

ADPs = np.transpose(Uiso_adp)
#fx.plot(T_all,ADPs[0],label='Sn1',color='r',
#		lw=0.8,ls='--',
#		marker='o',ms=ms,mew=0.8,mfc='w')
fx.errorbar(T_all,1000*ADPs[1],1000*ADPs[1]*3E-2,label='Sn(2)',
		#lw=0.8,ls='--',
		#marker='o',ms=ms,mew=0.8,mfc='w')
		#lw=0.8,ls='--',
		#marker='o',ms=ms,mew=0.8,mfc='w',
		#capsize=2,elinewidth=0.5,
		#color='dimgrey',alpha=1.0)
		color='dimgrey',alpha=1.0,
		lw=0,
		capsize=2,elinewidth=1.0,
		marker='o',ms=5,mew=0.8,mfc='w')

fx.set_xlim([95,205])
fx.set_xlabel(r'T (K)',fontsize=10)
fx.set_ylabel(r'$\mathrm{U_{iso}}$',fontsize=10) # latt

fx.tick_params(which='both', labelsize=9,
		labelbottom=True, labeltop=False, labelleft=False, labelright=True,
		bottom=False, top=False, left=False, right=True, direction='in')
#fig6.subplots_adjust(left = fig_l ,right = fig_r, bottom = 0.28, top = 0.99,wspace =0.02,hspace = 0.30) # one column
fig6.subplots_adjust(left = 0.17,right = 0.92, bottom = 0.20, top = 0.99,wspace =0.02,hspace = 0.30) # latt

fx.legend(fontsize=7,frameon=False)

show()
